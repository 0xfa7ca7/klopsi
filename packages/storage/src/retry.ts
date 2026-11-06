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

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const MONTH_INDEX = new Map(MONTHS.split("|").map((name, index) => [name, index]));
// RFC 9110 section 5.6.7: IMF-fixdate plus the obsolete RFC 850 and asctime forms.
const IMF_FIXDATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) (${MONTHS}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
  "u",
);
const RFC850_DATE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-(${MONTHS})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
  "u",
);
const ASCTIME_DATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (${MONTHS}) ([ \\d]\\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
  "u",
);

function utc(
  year: number,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): number | undefined {
  const monthIndex = MONTH_INDEX.get(month)!;
  const parts = [Number(day.trim()), Number(hour), Number(minute), Number(second)] as const;
  const time = Date.UTC(year, monthIndex, ...parts);
  const date = new Date(time);
  // Reject out-of-range components that Date.UTC would silently roll over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== parts[0] ||
    date.getUTCHours() !== parts[1] ||
    date.getUTCMinutes() !== parts[2] ||
    date.getUTCSeconds() !== parts[3]
  )
    return undefined;
  return time;
}

function parseHttpDate(value: string, now: number): number | undefined {
  let match = IMF_FIXDATE.exec(value);
  if (match !== null)
    return utc(Number(match[3]), match[2]!, match[1]!, match[4]!, match[5]!, match[6]!);
  match = RFC850_DATE.exec(value);
  if (match !== null) {
    // Two-digit years more than 50 years in the future denote the previous century.
    let year = 2000 + Number(match[3]);
    if (year > new Date(now).getUTCFullYear() + 50) year -= 100;
    return utc(year, match[2]!, match[1]!, match[4]!, match[5]!, match[6]!);
  }
  match = ASCTIME_DATE.exec(value);
  if (match !== null)
    return utc(Number(match[6]), match[1]!, match[2]!, match[3]!, match[4]!, match[5]!);
  return undefined;
}

/**
 * Parses `Retry-After` strictly as delta-seconds or an RFC 9110 HTTP-date, returning
 * milliseconds. Anything else yields `undefined` so callers fall back to jittered backoff.
 */
export function parseRetryAfter(
  value: string | readonly string[] | undefined | null,
  now: number = Date.now(),
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const date = parseHttpDate(trimmed, now);
  return date === undefined ? undefined : Math.max(0, date - now);
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
