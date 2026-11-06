/** Additional attempts after the first one, so three attempts in total. */
export const DEFAULT_DOWNLOAD_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETRESET",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

export type RetrySleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface DownloadRetryOptions {
  /** Base delay for exponential backoff with full jitter. */
  readonly baseDelayMs?: number;
  /** Upper bound for any single backoff and for an honoured `Retry-After`. */
  readonly maxDelayMs?: number;
  /** Uniform random source in `[0, 1)`; injectable for deterministic tests. */
  readonly random?: () => number;
  /** Abortable sleep; injectable for deterministic tests. */
  readonly sleep?: RetrySleep;
  /** Clock used to evaluate `Retry-After` HTTP dates. */
  readonly now?: () => number;
}

export interface DownloadRetryEvent {
  readonly method: "GET" | "HEAD";
  readonly origin: string;
  /** The attempt that just failed (1-based). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: string;
  readonly status?: number;
}

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

/** Returns the first transient network error code found in an error's cause chain. */
export function transientNetworkCode(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) return code;
    if ("cause" in current) pending.push((current as { cause?: unknown }).cause);
    const nested = (current as { errors?: unknown }).errors;
    if (Array.isArray(nested)) pending.push(...(nested as unknown[]));
  }
  return undefined;
}

/** Parses `Retry-After` as delta-seconds or an HTTP-date, returning milliseconds. */
export function parseRetryAfter(
  value: string | readonly string[] | undefined | null,
  now: number = Date.now(),
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  if (!/[A-Za-z]/u.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Full-jitter exponential backoff: uniform in `[0, min(max, base * 2^(attempt-1)))`. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const sample = Math.min(Math.max(random(), 0), 1);
  return Math.min(Math.floor(sample * ceiling), maxDelayMs);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export const abortableSleep: RetrySleep = async (milliseconds, signal) => {
  if (signal?.aborted) throw abortReason(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
