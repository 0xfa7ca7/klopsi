import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";

/** Upper bound for SQL read by `--sql-file`; the query policy SQL limit still applies afterwards. */
export const MAX_SQL_FILE_BYTES = 1024 * 1024;

export interface SqlFileStdin {
  readonly isTTY?: boolean;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

export interface SqlFileOptions {
  readonly cwd?: string;
  readonly stdin?: SqlFileStdin;
}

function invalid(message: string, context?: Readonly<Record<string, unknown>>): KlopsiError {
  return new KlopsiError({
    code: "QUERY_SQL_FILE_INVALID",
    message,
    exitCode: EXIT_CODES.INVALID_INPUT,
    ...(context === undefined ? {} : { context }),
  });
}

function tooLarge(): KlopsiError {
  return new KlopsiError({
    code: "QUERY_SQL_FILE_TOO_LARGE",
    message: `The SQL file exceeds the ${MAX_SQL_FILE_BYTES}-byte limit.`,
    exitCode: EXIT_CODES.INVALID_INPUT,
    context: { maximumBytes: MAX_SQL_FILE_BYTES },
  });
}

function decode(bytes: Uint8Array): string {
  try {
    // A fatal decoder rejects malformed UTF-8; the default BOM handling strips one leading BOM.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new KlopsiError({
      code: "QUERY_SQL_FILE_ENCODING",
      message: "The SQL file is not valid UTF-8.",
      exitCode: EXIT_CODES.INVALID_INPUT,
      suggestion: "Save the SQL file as UTF-8.",
    });
  }
}

function chunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return chunk;
  throw invalid("Standard input produced a non-byte chunk.");
}

async function readStdin(stdin: SqlFileStdin | undefined): Promise<Uint8Array> {
  const iterate = stdin?.[Symbol.asyncIterator];
  if (stdin === undefined || iterate === undefined || stdin.isTTY === true)
    throw invalid("--sql-file - requires SQL piped on standard input.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = iterate.call(stdin);
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const bytes = chunkBytes(next.value);
      total += bytes.length;
      if (total > MAX_SQL_FILE_BYTES) throw tooLarge();
      chunks.push(bytes);
    }
  } finally {
    await iterator.return?.();
  }
  return Buffer.concat(chunks, total);
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  let handle;
  try {
    // O_NONBLOCK keeps a FIFO or device from blocking before the regular-file check.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new KlopsiError({
        code: "QUERY_SQL_FILE_NOT_FOUND",
        message: "The SQL file does not exist.",
        exitCode: EXIT_CODES.NOT_FOUND,
        context: { path },
      });
    throw invalid("The SQL file could not be opened.", { path, reason: code ?? "unknown" });
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw invalid("--sql-file must name a regular file.", { path });
    if (details.size > MAX_SQL_FILE_BYTES) throw tooLarge();
    const buffer = Buffer.alloc(MAX_SQL_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_SQL_FILE_BYTES) throw tooLarge();
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EISDIR")
      throw invalid("--sql-file must name a regular file.", { path });
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Reads one SQL statement for `klopsi query --sql-file`. `-` reads piped standard
 * input. Input is bounded, must be strict UTF-8, and has one leading BOM removed.
 */
export async function readSqlFile(path: string, options: SqlFileOptions): Promise<string> {
  const bytes =
    path === "-"
      ? await readStdin(options.stdin)
      : await readRegularFile(resolve(options.cwd ?? process.cwd(), path));
  return decode(bytes);
}
