// Minimal ZIP plumbing for the in-house XLSX codec. Reading uses unzipit only to
// parse the central directory; entry data is streamed through node:zlib with
// size, CRC, and byte-limit checks so hostile workbooks cannot balloon memory.
// Writing produces a deterministic, non-ZIP64 archive with streamed entries.
import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createDeflateRaw, createInflateRaw, crc32 } from "node:zlib";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { unzipRaw, type Reader, type ZipEntry } from "unzipit";

export function invalidXlsx(message: string, cause?: unknown): KlopsiError {
  return new KlopsiError({
    code: "INVALID_XLSX_DATA",
    message,
    exitCode: EXIT_CODES.INTEGRITY_FAILURE,
    suggestion: "Re-save the workbook in a spreadsheet application or export it to CSV.",
    ...(cause === undefined ? {} : { cause }),
  });
}

export function xlsxLimit(
  message: string,
  context: Readonly<Record<string, unknown>>,
): KlopsiError {
  return new KlopsiError({
    code: "XLSX_LIMIT_EXCEEDED",
    message,
    exitCode: EXIT_CODES.UNSUPPORTED,
    suggestion: "Convert the workbook to CSV or Parquet before processing it.",
    context,
  });
}

/** Bounded positional reader: never allocates beyond the real file length. */
class BoundedFileReader implements Reader {
  private constructor(
    private readonly handle: FileHandle,
    private readonly length: number,
  ) {}

  static async open(path: string): Promise<BoundedFileReader> {
    const handle = await open(path, "r");
    try {
      return new BoundedFileReader(handle, (await handle.stat()).size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  getLength(): Promise<number> {
    return Promise.resolve(this.length);
  }

  async read(offset: number, size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0)
      throw new Error("Invalid ZIP read range.");
    if (offset + size > this.length) throw new Error("ZIP structure points beyond the file end.");
    const bytes = new Uint8Array(size);
    const { bytesRead } = await this.handle.read(bytes, 0, size, offset);
    if (bytesRead !== size) throw new Error("Unexpected end of ZIP file.");
    return bytes;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

interface RawEntry {
  readonly relativeOffsetOfLocalHeader: number;
  readonly compressionMethod: number;
  readonly generalPurposeBitFlag: number;
  readonly crc32: number;
}

export interface PackageEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

export interface ZipPackage {
  readonly path: string;
  readonly fileLength: number;
  entry(name: string): PackageEntry | undefined;
}

/**
 * unzipit's public API inflates whole entries into memory, so streaming needs
 * the local-header offset, method, and CRC from its private `_rawEntry`. That
 * shape is verified against the exact pin (unzipit 1.4.3) in
 * test/xlsx-reader.test.ts; re-check it before bumping the dependency.
 */
function packageEntry(entry: ZipEntry): PackageEntry {
  const raw = (entry as unknown as { readonly _rawEntry?: Partial<RawEntry> })._rawEntry;
  if (
    raw === undefined ||
    typeof raw.relativeOffsetOfLocalHeader !== "number" ||
    typeof raw.compressionMethod !== "number" ||
    typeof raw.generalPurposeBitFlag !== "number" ||
    typeof raw.crc32 !== "number"
  )
    throw new KlopsiError({
      code: "XLSX_ZIP_BACKEND_INCOMPATIBLE",
      message:
        "The installed unzipit no longer exposes ZipEntry._rawEntry as in unzipit 1.4.3; the XLSX reader cannot stream entries.",
      exitCode: EXIT_CODES.INTERNAL,
      suggestion: "Reinstall klopsi with its pinned dependencies (unzipit 1.4.3).",
    });
  return {
    name: entry.name,
    nameBytes: entry.nameBytes,
    size: entry.size,
    compressedSize: entry.compressedSize,
    method: raw.compressionMethod,
    crc: raw.crc32 >>> 0,
    localHeaderOffset: raw.relativeOffsetOfLocalHeader,
  };
}

export async function openZipPackage(path: string, maxEntries: number): Promise<ZipPackage> {
  let reader: BoundedFileReader;
  try {
    reader = await BoundedFileReader.open(path);
  } catch (error) {
    throw invalidXlsx("The XLSX file cannot be opened.", error);
  }
  try {
    const { entries } = await unzipRaw(reader);
    if (entries.length > maxEntries)
      throw xlsxLimit("The XLSX package contains too many ZIP entries.", {
        entries: entries.length,
        limit: maxEntries,
      });
    const exact = new Map<string, PackageEntry>();
    const folded = new Map<string, PackageEntry>();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const value = packageEntry(entry);
      const key = value.name.toLowerCase();
      // Duplicate part names make the package ambiguous; readers would disagree.
      if (folded.has(key)) throw invalidXlsx("The XLSX package contains duplicate ZIP entries.");
      if ((value.method !== 0 && value.method !== 8) || entry.encrypted)
        throw invalidXlsx("The XLSX package uses encrypted or unsupported ZIP entries.");
      exact.set(value.name, value);
      folded.set(key, value);
    }
    const fileLength = await reader.getLength();
    return {
      path,
      fileLength,
      entry: (name) => exact.get(name) ?? folded.get(name.toLowerCase()),
    };
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    throw invalidXlsx("The XLSX file is not a readable ZIP package.", error);
  } finally {
    await reader.close();
  }
}

async function dataStart(pkg: ZipPackage, entry: PackageEntry): Promise<number> {
  const handle = await open(pkg.path, "r");
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50)
      throw invalidXlsx("The XLSX package has a corrupt local ZIP header.");
    const nameLength = header.readUInt16LE(26);
    const name = Buffer.alloc(nameLength);
    const nameRead = await handle.read(name, 0, nameLength, entry.localHeaderOffset + 30);
    // A local header that disagrees with the central directory is a classic
    // parser-differential trick; refuse it rather than pick a side.
    if (
      nameRead.bytesRead !== nameLength ||
      !name.equals(entry.nameBytes) ||
      header.readUInt16LE(8) !== entry.method
    )
      throw invalidXlsx("The XLSX local ZIP header disagrees with the central directory.");
    const start = entry.localHeaderOffset + 30 + nameLength + header.readUInt16LE(28);
    if (start + entry.compressedSize > pkg.fileLength)
      throw invalidXlsx("The XLSX ZIP entry extends beyond the end of the file.");
    return start;
  } finally {
    await handle.close();
  }
}

/**
 * Streams the inflated bytes of one entry. Throws when the output would exceed
 * either the configured limit or the size recorded in the ZIP directory, and
 * verifies the recorded CRC-32 once the entry is fully consumed.
 */
export async function* entryChunks(
  pkg: ZipPackage,
  entry: PackageEntry,
  limit: number,
  onLimit: () => KlopsiError,
): AsyncGenerator<Buffer> {
  if (entry.size > limit) throw onLimit();
  const start = await dataStart(pkg, entry);
  if (entry.compressedSize === 0) {
    if (entry.size !== 0 || entry.crc !== 0)
      throw invalidXlsx("The XLSX ZIP entry size does not match its contents.");
    return;
  }
  const raw = createReadStream(pkg.path, { start, end: start + entry.compressedSize - 1 });
  const source = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  if (source !== raw) raw.on("error", (error) => source.destroy(error));
  let bytes = 0;
  let crc = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > entry.size)
        throw bytes > limit
          ? onLimit()
          : invalidXlsx("The XLSX ZIP entry is larger than its recorded size.");
      crc = crc32(chunk, crc);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    throw invalidXlsx("The XLSX ZIP entry cannot be decompressed.", error);
  } finally {
    raw.destroy();
    source.destroy();
  }
  if (bytes !== entry.size || crc >>> 0 !== entry.crc)
    throw invalidXlsx("The XLSX ZIP entry failed its size or CRC check.");
}

// ---------------------------------------------------------------------------
// Writing

const MAX_ZIP32 = 0xffffffff;
// 1980-01-01 00:00:00 in MS-DOS format keeps output byte-for-byte deterministic.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

interface WrittenEntry {
  readonly name: Buffer;
  readonly offset: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
}

export class ZipFileWriter {
  private position = 0;
  private readonly entries: WrittenEntry[] = [];

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<ZipFileWriter> {
    return new ZipFileWriter(await open(path, "wx"));
  }

  private async write(bytes: Uint8Array): Promise<void> {
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await this.handle.write(
        bytes,
        written,
        bytes.length - written,
        this.position,
      );
      written += bytesWritten;
      this.position += bytesWritten;
    }
  }

  private tooLarge(): KlopsiError {
    return xlsxLimit("The XLSX output exceeds the 4 GiB ZIP32 limit.", { limit: MAX_ZIP32 });
  }

  /** Adds a deflated entry, streaming the source and patching sizes in place. */
  async add(
    name: string,
    source: AsyncIterable<string | Uint8Array> | Iterable<string>,
  ): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    const offset = this.position;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(header);
    await this.write(nameBytes);

    const deflate = createDeflateRaw({ level: 6 });
    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    const feed = (async () => {
      try {
        for await (const chunk of source) {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
          if (bytes.length === 0) continue;
          crc = crc32(bytes, crc);
          size += bytes.length;
          if (size > MAX_ZIP32) throw this.tooLarge();
          if (deflate.destroyed) throw new Error("ZIP deflate stream closed early.");
          if (!deflate.write(bytes))
            await new Promise<void>((resolve, reject) => {
              const cleanup = (): void => {
                deflate.off("drain", done);
                deflate.off("close", closed);
              };
              const done = (): void => {
                cleanup();
                resolve();
              };
              const closed = (): void => {
                cleanup();
                reject(new Error("ZIP deflate stream closed early."));
              };
              deflate.once("drain", done);
              deflate.once("close", closed);
            });
        }
        deflate.end();
      } catch (error) {
        deflate.destroy(error as Error);
        throw error;
      }
    })();
    const drain = (async () => {
      try {
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          compressedSize += chunk.length;
          if (this.position + chunk.length > MAX_ZIP32) throw this.tooLarge();
          await this.write(chunk);
        }
      } catch (error) {
        deflate.destroy();
        throw error;
      }
    })();
    const [fed, drained] = await Promise.allSettled([feed, drain]);
    // Feed failures destroy the deflate stream with the same error, so the
    // drain-side reason is always the root cause when both reject.
    if (drained.status === "rejected") throw drained.reason;
    if (fed.status === "rejected") throw fed.reason;

    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc >>> 0, 0);
    sizes.writeUInt32LE(compressedSize, 4);
    sizes.writeUInt32LE(size, 8);
    await this.handle.write(sizes, 0, 12, offset + 14);
    this.entries.push({ name: nameBytes, offset, crc: crc >>> 0, compressedSize, size });
  }

  /** Writes the central directory and closes the file. */
  async finish(): Promise<void> {
    const start = this.position;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await this.write(header);
      await this.write(entry.name);
    }
    const size = this.position - start;
    if (this.position > MAX_ZIP32 || this.entries.length > 0xffff) throw this.tooLarge();
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await this.close();
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}
