import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EXIT_CODES, KlopsiError, type FailureExitCode } from "@klopsi/domain";
import { request, type Dispatcher } from "undici";
import { CacheLock } from "./cache-lock.js";
import { isPublicAddress } from "./ip-policy.js";
import {
  DEFAULT_DOWNLOAD_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  abortableSleep,
  backoffDelay,
  isRetryableHttpStatus,
  parseRetryAfter,
  transientNetworkCode,
  type DownloadRetryEvent,
  type DownloadRetryOptions,
  type RetrySleep,
} from "./retry.js";
import { SafeDispatcherFactory } from "./safe-dispatcher.js";

export interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
  /**
   * Additional attempts after a transient failure (network error, per-attempt timeout, or HTTP
   * 408/425/429/500/502/503/504). Defaults to 2 (three attempts in total); 0 disables retries.
   * `timeoutMs` applies to each attempt.
   */
  readonly retries?: number;
}
export interface DownloadInput {
  readonly url: string;
  readonly destination: string;
  readonly limits: DownloadLimits;
  readonly allowedOrigins?: readonly string[];
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface DownloadResult {
  readonly path: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly bytes: number;
  readonly mediaType?: string;
  readonly sha256: string;
  readonly etag?: string;
  readonly lastModified?: string;
  /** Network attempts used to fetch the content, including the successful one. */
  readonly attempts?: number;
}
export interface ProbeResult {
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** Network attempts used, including the final one. */
  readonly attempts?: number;
}
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
function failure(
  code: string,
  message: string,
  exitCode: FailureExitCode = EXIT_CODES.PROVIDER_FAILURE,
  cause?: unknown,
): KlopsiError {
  return new KlopsiError({ code, message, exitCode, ...(cause === undefined ? {} : { cause }) });
}
function policyError(error: unknown): KlopsiError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof KlopsiError && current.code === "NETWORK_ADDRESS_FORBIDDEN")
      return current;
    seen.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}
function parseUrl(raw: string, base?: URL): URL {
  try {
    return new URL(raw, base);
  } catch (error) {
    throw failure(
      "INVALID_DOWNLOAD_URL",
      "The download URL is invalid.",
      EXIT_CODES.INVALID_INPUT,
      error,
    );
  }
}
function validateUrl(
  url: URL,
  allowInsecureHttp: boolean,
  allowPrivateNetwork: boolean,
  previous?: URL,
): URL {
  if (url.username !== "" || url.password !== "" || url.hash !== "")
    throw failure(
      "INVALID_DOWNLOAD_URL",
      "Download URLs may not contain credentials or fragments.",
      EXIT_CODES.INVALID_INPUT,
    );
  if (previous?.protocol === "https:" && url.protocol === "http:" && !allowInsecureHttp)
    throw failure(
      "HTTPS_DOWNGRADE_FORBIDDEN",
      "HTTPS redirects may not downgrade to HTTP.",
      EXIT_CODES.INVALID_INPUT,
    );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecureHttp))
    throw failure(
      "INSECURE_DOWNLOAD_URL",
      "Only HTTPS download URLs are permitted.",
      EXIT_CODES.INVALID_INPUT,
    );
  if (
    !allowPrivateNetwork &&
    /^[\d.]+$|:/u.test(url.hostname) &&
    !isPublicAddress(url.hostname.replace(/^\[|\]$/gu, ""))
  )
    throw failure(
      "NETWORK_ADDRESS_FORBIDDEN",
      "The destination uses a private or special-purpose address.",
      EXIT_CODES.INVALID_INPUT,
    );
  return url;
}
function validateAllowedOrigin(url: URL, allowedOrigins: ReadonlySet<string> | undefined): void {
  if (allowedOrigins !== undefined && !allowedOrigins.has(url.origin)) {
    throw new KlopsiError({
      code: "DOWNLOAD_ORIGIN_FORBIDDEN",
      message: "The download origin is not allowed.",
      exitCode: EXIT_CODES.PROVIDER_FAILURE,
      context: { origin: url.origin },
    });
  }
}
function headersRecord(
  headers: Record<string, string | string[] | undefined>,
): Readonly<Record<string, string | readonly string[]>> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] => entry[1] !== undefined,
    ),
  );
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Opening directories is not supported on every Node platform.
  }
}

async function digestRegularFile(
  path: string,
): Promise<{ sha256: string; bytes: number } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile()) return undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: hash.digest("hex"), bytes: details.size };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface DownloaderOptions {
  readonly retry?: DownloadRetryOptions;
  /** Called before each backoff sleep; use it to surface retry warnings. */
  readonly onRetry?: (event: DownloadRetryEvent) => void;
}

interface FetchedResponse {
  response: Awaited<ReturnType<typeof request>>;
  url: URL;
  chain: string[];
  dispatcher: Dispatcher;
}

interface StagedDownload {
  readonly temp: string;
  readonly url: URL;
  readonly chain: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface TransientFailure {
  readonly reason: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

const transientHttpFailures = new WeakMap<KlopsiError, TransientFailure>();

function discardBody(response: FetchedResponse["response"]): void {
  response.body.on("error", () => undefined);
  response.body.destroy();
}

function httpError(response: FetchedResponse["response"], now: number): KlopsiError {
  const status = response.statusCode;
  const error = new KlopsiError({
    code: "DOWNLOAD_HTTP_ERROR",
    message: `The download returned HTTP ${status}.`,
    exitCode: EXIT_CODES.PROVIDER_FAILURE,
    context: { status },
  });
  if (isRetryableHttpStatus(status)) {
    const retryAfterMs = parseRetryAfter(response.headers["retry-after"], now);
    transientHttpFailures.set(error, {
      reason: `HTTP ${status}`,
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return error;
}

function networkFailure(error: unknown, timedOut: boolean): KlopsiError {
  if (error instanceof KlopsiError) return error;
  return failure(
    "DOWNLOAD_FAILED",
    timedOut ? "The download request timed out." : "The download request failed.",
    EXIT_CODES.PROVIDER_FAILURE,
    error,
  );
}

function cancelled(cause: unknown): KlopsiError {
  return failure(
    "DOWNLOAD_CANCELLED",
    "The download was cancelled.",
    EXIT_CODES.PROVIDER_FAILURE,
    cause,
  );
}

function withAttempts(
  error: unknown,
  attempts: number,
  extra: Readonly<Record<string, unknown>> = {},
): unknown {
  if (
    !(error instanceof KlopsiError) ||
    (error.code !== "DOWNLOAD_HTTP_ERROR" && error.code !== "DOWNLOAD_FAILED")
  )
    return error;
  const annotated = new KlopsiError({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    context: { ...error.context, attempts, ...extra },
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
  // Keep the stack of the original failure site rather than this annotation helper.
  if (error.stack !== undefined) annotated.stack = error.stack;
  return annotated;
}

export class Downloader {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: RetrySleep;
  private readonly now: () => number;
  private readonly onRetry: ((event: DownloadRetryEvent) => void) | undefined;

  constructor(
    private readonly dispatchers = new SafeDispatcherFactory(),
    options: DownloaderOptions = {},
  ) {
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxDelayMs = options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.random = options.retry?.random ?? Math.random;
    this.sleep = options.retry?.sleep ?? abortableSleep;
    this.now = options.retry?.now ?? Date.now;
    this.onRetry = options.onRetry;
  }

  private async response(
    input: DownloadInput,
    method: "GET" | "HEAD",
    timedOut: () => boolean,
    onRequest: (url: URL) => void = () => undefined,
  ): Promise<FetchedResponse> {
    const allowHttp = input.allowInsecureHttp ?? false;
    const allowPrivate = input.allowPrivateNetwork ?? false;
    const maxRedirects = input.limits.maxRedirects ?? 5;
    const allowedOrigins =
      input.allowedOrigins === undefined
        ? undefined
        : new Set(input.allowedOrigins.map((value) => new URL(value).origin));
    let url = parseUrl(input.url);
    validateAllowedOrigin(url, allowedOrigins);
    url = validateUrl(url, allowHttp, allowPrivate);
    const chain: string[] = [];
    let headers: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(input.headers ?? {}).filter(
          ([name]) => name.toLowerCase() !== "accept-encoding",
        ),
      ),
      "accept-encoding": "identity",
    };
    for (let redirect = 0; ; redirect++) {
      chain.push(url.toString());
      onRequest(url);
      const dispatcher = this.dispatchers.create(url, allowPrivate);
      let response;
      try {
        response = await request(url, {
          method,
          dispatcher,
          headers,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          headersTimeout: input.limits.headersTimeoutMs ?? Math.min(input.limits.timeoutMs, 15_000),
          bodyTimeout: input.limits.bodyTimeoutMs ?? Math.min(input.limits.timeoutMs, 30_000),
        });
      } catch (error) {
        await dispatcher.close();
        const forbidden = policyError(error);
        if (forbidden !== undefined) throw forbidden;
        throw networkFailure(error, timedOut());
      }
      const location = response.headers.location;
      const isRedirect =
        response.statusCode >= 300 && response.statusCode < 400 && typeof location === "string";
      if (!isRedirect) return { response, url, chain, dispatcher };
      discardBody(response);
      await dispatcher.close();
      if (redirect >= maxRedirects)
        throw failure(
          "TOO_MANY_REDIRECTS",
          "The download exceeded the redirect limit.",
          EXIT_CODES.INVALID_INPUT,
        );
      const next = parseUrl(location, url);
      validateAllowedOrigin(next, allowedOrigins);
      validateUrl(next, allowHttp, allowPrivate, url);
      if (next.origin !== url.origin)
        headers = Object.fromEntries(
          Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())),
        );
      url = next;
    }
  }

  /**
   * Runs idempotent attempts with bounded retries. Each attempt receives a fresh per-attempt
   * timeout. Only transient failures (selected network errors, attempt timeouts, and retryable
   * HTTP statuses) are retried; policy, size, integrity, and caller-abort failures are not.
   */
  private async withRetries<Result>(
    input: Omit<DownloadInput, "destination">,
    method: "GET" | "HEAD",
    attempt: (
      signal: AbortSignal,
      timedOut: () => boolean,
      onRequest: (url: URL) => void,
    ) => Promise<Result>,
    transientResult: (value: Result) => TransientFailure | undefined = () => undefined,
  ): Promise<{ value: Result; attempts: number }> {
    const retries = input.limits.retries ?? DEFAULT_DOWNLOAD_RETRIES;
    const maxAttempts = Number.isSafeInteger(retries) && retries > 0 ? retries + 1 : 1;
    const userSignal = input.signal;
    for (let current = 1; ; current++) {
      if (userSignal?.aborted) throw cancelled(userSignal.reason);
      const timeout = AbortSignal.timeout(input.limits.timeoutMs);
      const signal = userSignal === undefined ? timeout : AbortSignal.any([userSignal, timeout]);
      const timedOut = () => timeout.aborted && userSignal?.aborted !== true;
      let transient: TransientFailure | undefined;
      let failed: { readonly error: unknown } | { readonly value: Result };
      // The origin last contacted in this attempt, which follows redirects.
      let origin = parseUrl(input.url).origin;
      try {
        const value = await attempt(signal, timedOut, (url) => {
          origin = url.origin;
        });
        transient = transientResult(value);
        if (transient === undefined) return { value, attempts: current };
        failed = { value };
      } catch (error) {
        if (userSignal?.aborted) throw cancelled(error);
        transient = this.classify(error, timedOut());
        if (transient === undefined) throw withAttempts(error, current);
        failed = { error };
      }
      const giveUp = (extra: Readonly<Record<string, unknown>> = {}) => {
        if ("value" in failed) return { value: failed.value, attempts: current };
        throw withAttempts(failed.error, current, extra);
      };
      if (current >= maxAttempts) return giveUp();
      if (transient.retryAfterMs !== undefined && transient.retryAfterMs > this.maxDelayMs)
        return giveUp({ retryAfterMs: transient.retryAfterMs });
      // A zero or past Retry-After never shortens the jittered backoff.
      const delayMs = Math.max(
        transient.retryAfterMs ?? 0,
        backoffDelay(current, this.baseDelayMs, this.maxDelayMs, this.random),
      );
      this.onRetry?.({
        method,
        origin,
        attempt: current,
        maxAttempts,
        delayMs,
        reason: transient.reason,
        ...(transient.status === undefined ? {} : { status: transient.status }),
      });
      try {
        await this.sleep(delayMs, userSignal);
      } catch (error) {
        throw cancelled(error);
      }
    }
  }

  private classify(error: unknown, timedOut: boolean): TransientFailure | undefined {
    if (!(error instanceof KlopsiError)) return undefined;
    const http = transientHttpFailures.get(error);
    if (http !== undefined) return http;
    if (error.code !== "DOWNLOAD_FAILED") return undefined;
    if (timedOut) return { reason: "the request timed out" };
    const code = transientNetworkCode(error);
    return code === undefined ? undefined : { reason: `network error ${code}` };
  }

  async probe(input: Omit<DownloadInput, "destination">): Promise<ProbeResult> {
    const { value, attempts } = await this.withRetries(
      input,
      "HEAD",
      async (signal, timedOut, onRequest) => {
        const { response, url, chain, dispatcher } = await this.response(
          { ...input, destination: "", signal },
          "HEAD",
          timedOut,
          onRequest,
        );
        try {
          try {
            await response.body.dump();
          } catch (error) {
            throw networkFailure(error, timedOut());
          }
          return {
            finalUrl: url.toString(),
            redirectChain: chain,
            status: response.statusCode,
            headers: headersRecord(response.headers),
          };
        } finally {
          await dispatcher.close();
        }
      },
      (result) => {
        if (!isRetryableHttpStatus(result.status)) return undefined;
        const retryAfterMs = parseRetryAfter(result.headers["retry-after"], this.now());
        return {
          reason: `HTTP ${result.status}`,
          status: result.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      },
    );
    return { ...value, attempts };
  }

  /** Streams one attempt into a fresh private temporary file; removes it on any failure. */
  private async stage(
    input: DownloadInput,
    destination: string,
    signal: AbortSignal,
    timedOut: () => boolean,
    onRequest: (url: URL) => void,
  ): Promise<StagedDownload> {
    const temp = `${destination}.part-${process.pid}-${randomUUID()}`;
    let fetched: FetchedResponse | undefined;
    let handle;
    try {
      fetched = await this.response({ ...input, destination, signal }, "GET", timedOut, onRequest);
      const { response, url, chain } = fetched;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        discardBody(response);
        throw httpError(response, this.now());
      }
      const declared = response.headers["content-length"];
      if (typeof declared === "string" && Number(declared) > input.limits.maxBytes) {
        discardBody(response);
        throw failure(
          "DOWNLOAD_TOO_LARGE",
          "The download exceeds the byte limit.",
          EXIT_CODES.INVALID_INPUT,
        );
      }
      handle = await open(temp, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      const chunks = response.body[Symbol.asyncIterator]();
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          next = await chunks.next();
        } catch (error) {
          throw networkFailure(error, timedOut());
        }
        if (next.done === true) break;
        const chunk = Buffer.from(next.value as Uint8Array);
        bytes += chunk.length;
        if (bytes > input.limits.maxBytes) {
          discardBody(response);
          throw failure(
            "DOWNLOAD_TOO_LARGE",
            "The download exceeds the byte limit.",
            EXIT_CODES.INVALID_INPUT,
          );
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      return { temp, url, chain, bytes, sha256: hash.digest("hex"), headers: response.headers };
    } catch (error) {
      if (fetched !== undefined) discardBody(fetched.response);
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    } finally {
      await fetched?.dispatcher.close().catch(() => undefined);
    }
  }

  async download(input: DownloadInput): Promise<DownloadResult> {
    const destination = resolve(input.destination);
    const directory = dirname(destination);
    const lockTimeout = AbortSignal.timeout(input.limits.timeoutMs);
    const lockSignal =
      input.signal === undefined ? lockTimeout : AbortSignal.any([input.signal, lockTimeout]);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lock: CacheLock;
    try {
      lock = await CacheLock.acquire(directory, `download:${destination}`, {
        signal: lockSignal,
      });
    } catch (error) {
      if (input.signal?.aborted === true) throw cancelled(error);
      throw error;
    }
    let staged: StagedDownload | undefined;
    try {
      const { value, attempts } = await this.withRetries(
        input,
        "GET",
        (signal, timedOut, onRequest) =>
          this.stage(input, destination, signal, timedOut, onRequest),
      );
      staged = value;
      const { temp, url, chain, bytes, sha256, headers } = staged;
      if (input.force) {
        try {
          const current = await lstat(destination);
          if (!current.isFile() || current.isSymbolicLink())
            throw failure(
              "UNSAFE_DOWNLOAD_DESTINATION",
              "The destination is not a regular file.",
              EXIT_CODES.INVALID_INPUT,
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temp, destination);
      } else {
        try {
          await link(temp, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = await digestRegularFile(destination);
            if (existing?.sha256 === sha256 && existing.bytes === bytes) {
              await unlink(temp);
            } else {
              throw failure(
                "DOWNLOAD_DESTINATION_EXISTS",
                "The destination already exists.",
                EXIT_CODES.INVALID_INPUT,
              );
            }
          } else {
            throw error;
          }
        }
        await unlink(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      await syncDirectory(directory);
      return {
        path: destination,
        finalUrl: url.toString(),
        redirectChain: chain,
        bytes,
        ...(typeof headers["content-type"] === "string"
          ? { mediaType: headers["content-type"].split(";", 1)[0] }
          : {}),
        sha256,
        ...(typeof headers.etag === "string" ? { etag: headers.etag } : {}),
        ...(typeof headers["last-modified"] === "string"
          ? { lastModified: headers["last-modified"] }
          : {}),
        attempts,
      };
    } catch (error) {
      if (staged !== undefined) await rm(staged.temp, { force: true });
      throw error;
    } finally {
      await lock.release();
    }
  }
}
