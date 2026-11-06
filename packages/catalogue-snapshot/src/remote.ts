import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { Downloader } from "@klopsi/storage";
import { snapshotInvalid, snapshotUnavailable } from "./errors.js";

export const DEFAULT_CATALOGUE_BASE_URL = "https://0xfa7ca7.github.io/klopsi/";
const DEFAULT_CATALOGUE_TIMEOUT_MS = 9_500;

export interface StrictHttpsReaderOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly downloader?: Downloader;
  /** Allows controlled local HTTP fixtures. Do not use in production construction. */
  readonly testOnlyDownloaderOptions?: {
    readonly allowInsecureHttp?: boolean;
    readonly allowPrivateNetwork?: boolean;
  };
}

const CATALOGUE_VALIDATION_CODES = new Set([
  "CATALOGUE_SNAPSHOT_INVALID",
  "CATALOGUE_SNAPSHOT_INTEGRITY",
  "CATALOGUE_SNAPSHOT_STALE",
]);
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const ASCII_TAB = 0x09;
const ASCII_LF = 0x0a;
const ASCII_CR = 0x0d;
const ASCII_SPACE = 0x20;

export class StrictHttpsReader {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly downloader: Downloader;
  private readonly testOnlyDownloaderOptions: NonNullable<
    StrictHttpsReaderOptions["testOnlyDownloaderOptions"]
  >;

  constructor(options: StrictHttpsReaderOptions = {}) {
    this.testOnlyDownloaderOptions = options.testOnlyDownloaderOptions ?? {};
    this.base = catalogueBaseUrl(
      options.baseUrl ?? DEFAULT_CATALOGUE_BASE_URL,
      this.testOnlyDownloaderOptions.allowInsecureHttp ?? false,
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOGUE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new KlopsiError({
        code: "INVALID_CATALOGUE_TIMEOUT",
        message: "The catalogue timeout must be a positive integer.",
        exitCode: EXIT_CODES.INVALID_INPUT,
      });
    }
    this.downloader = options.downloader ?? new Downloader();
  }

  async read(relativePath: string, maxBytes: number, timeoutMs?: number): Promise<Uint8Array> {
    const url = resolveRelativePath(this.base, relativePath);
    return this.readUrl(url, maxBytes, false, this.requestTimeoutMs(timeoutMs));
  }

  async readOptional(relativePath: string, maxBytes: number): Promise<Uint8Array | undefined> {
    const url = resolveRelativePath(this.base, relativePath);
    return this.readUrl(url, maxBytes, true);
  }

  async readCacheBusted(
    relativePath: string,
    maxBytes: number,
    cacheBust: string,
  ): Promise<Uint8Array> {
    const url = resolveRelativePath(this.base, relativePath);
    if (!/^[A-Za-z0-9._-]+$/u.test(cacheBust)) throw invalidPath("cacheBust");
    url.searchParams.set("cacheBust", cacheBust);
    return this.readUrl(url, maxBytes);
  }

  private async readUrl(
    url: URL,
    maxBytes: number,
    allowNotFound?: false,
    timeoutMs?: number,
  ): Promise<Uint8Array>;
  private async readUrl(
    url: URL,
    maxBytes: number,
    allowNotFound: true,
    timeoutMs?: number,
  ): Promise<Uint8Array | undefined>;
  private async readUrl(
    url: URL,
    maxBytes: number,
    allowNotFound = false,
    timeoutMs = this.timeoutMs,
  ): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalidPath("maxBytes");

    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "klopsi-catalogue-remote-"));
      const result = await this.downloader.download({
        url: url.toString(),
        destination: join(directory, "payload"),
        allowedOrigins: [this.base.origin],
        limits: {
          maxBytes,
          timeoutMs,
          // Snapshot reads run under fixed end-to-end deadlines and fall back to live
          // metadata, so they never multiply that budget with content-download retries.
          retries: 0,
          ...(allowNotFound ? { maxRedirects: 0 } : {}),
        },
        ...(this.testOnlyDownloaderOptions.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: this.testOnlyDownloaderOptions.allowInsecureHttp }),
        ...(this.testOnlyDownloaderOptions.allowPrivateNetwork === undefined
          ? {}
          : { allowPrivateNetwork: this.testOnlyDownloaderOptions.allowPrivateNetwork }),
      });

      const handle = await open(result.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const details = await handle.stat();
        if (!details.isFile()) throw new Error("Downloaded catalogue payload is not a file.");
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (allowNotFound && isHttpNotFound(error)) return undefined;
      if (isCatalogueValidationError(error)) throw error;
      if (error instanceof KlopsiError && error.code === "DOWNLOAD_TOO_LARGE") {
        throw snapshotInvalid("bytes");
      }
      throw snapshotUnavailable();
    } finally {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private requestTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new KlopsiError({
        code: "INVALID_CATALOGUE_TIMEOUT",
        message: "The catalogue timeout must be a positive integer.",
        exitCode: EXIT_CODES.INVALID_INPUT,
      });
    }
    return Math.min(this.timeoutMs, timeoutMs);
  }
}

function catalogueBaseUrl(raw: string, allowInsecureHttp: boolean): URL {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw invalidBaseUrl();
  }
  if (
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.protocol !== "https:" && !(allowInsecureHttp && base.protocol === "http:"))
  ) {
    throw invalidBaseUrl();
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

function resolveRelativePath(base: URL, relativePath: string): URL {
  if (containsUrlStrippedControl(relativePath)) throw invalidPath("relativePath");
  if (hasUrlTrimmableEdge(relativePath)) throw invalidPath("relativePath");
  if (
    relativePath.length === 0 ||
    URL_SCHEME.test(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("?") ||
    relativePath.includes("#")
  ) {
    throw invalidPath("relativePath");
  }

  try {
    for (const rawSegment of relativePath.split("/")) {
      const segment = decodeURIComponent(rawSegment);
      if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
        throw invalidPath("relativePath");
      }
    }
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    throw invalidPath("relativePath");
  }

  let resolved: URL;
  try {
    resolved = new URL(relativePath, base);
  } catch {
    throw invalidPath("relativePath");
  }
  if (
    resolved.origin !== base.origin ||
    resolved.username !== "" ||
    resolved.password !== "" ||
    resolved.search !== "" ||
    resolved.hash !== "" ||
    !resolved.pathname.startsWith(base.pathname) ||
    resolved.pathname === base.pathname
  ) {
    throw invalidPath("relativePath");
  }
  return resolved;
}

function containsUrlStrippedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === ASCII_TAB || code === ASCII_LF || code === ASCII_CR) return true;
  }
  return false;
}

function hasUrlTrimmableEdge(value: string): boolean {
  if (value.length === 0) return false;
  return value.charCodeAt(0) <= ASCII_SPACE || value.charCodeAt(value.length - 1) <= ASCII_SPACE;
}

function isCatalogueValidationError(error: unknown): error is KlopsiError {
  return error instanceof KlopsiError && CATALOGUE_VALIDATION_CODES.has(error.code);
}

function isHttpNotFound(error: unknown): error is KlopsiError {
  return (
    error instanceof KlopsiError &&
    error.code === "DOWNLOAD_HTTP_ERROR" &&
    error.message === "The download returned HTTP 404."
  );
}

function invalidBaseUrl(): KlopsiError {
  return new KlopsiError({
    code: "INVALID_CATALOGUE_BASE_URL",
    message: "The catalogue base URL is invalid.",
    exitCode: EXIT_CODES.INVALID_INPUT,
  });
}

function invalidPath(field: string): KlopsiError {
  return snapshotInvalid(field);
}
