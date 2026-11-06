import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { duckDbMemoryLimitBytes, EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { stageTabularInput, type TabularStage } from "./tabular-stage.js";
import { validateQueryParameters, type QueryParameter } from "./query-parameters.js";
import type { DataInput } from "./types.js";
import type {
  QueryLimits,
  QueryResult,
  QueryWorkerMessage,
  QueryWorkerRequest,
} from "./query-protocol.js";

const DEFAULT_LIMITS: QueryLimits = {
  rowLimit: 1_000,
  timeoutMs: 30_000,
  maxSqlBytes: 64 * 1024,
  maxColumns: 256,
  maxCellBytes: 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  memoryLimit: "1GB",
  threads: 4,
};
const MAX_LIMITS = {
  rowLimit: 1_000_000,
  timeoutMs: 600_000,
  maxSqlBytes: 64 * 1024,
  maxColumns: 4_096,
  maxCellBytes: 16 * 1024 * 1024,
  maxOutputBytes: 256 * 1024 * 1024,
  threads: 4,
} as const;

function boundedLimit(name: keyof typeof MAX_LIMITS, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMITS[name])
    throw new KlopsiError({
      code: "QUERY_LIMIT_INVALID",
      message: `${name} must be a positive integer no larger than ${MAX_LIMITS[name]}.`,
      exitCode: EXIT_CODES.QUERY_FAILURE,
      context: { limit: name, value, maximum: MAX_LIMITS[name] },
    });
  return value;
}

export interface QueryExecutionOptions {
  readonly input: DataInput;
  readonly sql: string;
  /** Named `$name` parameters bound through DuckDB prepared-statement bindings. */
  readonly parameters?: readonly QueryParameter[];
  readonly rowLimit?: number;
  readonly timeoutMs?: number;
  readonly maxSqlBytes?: number;
  readonly maxColumns?: number;
  readonly maxCellBytes?: number;
  readonly maxOutputBytes?: number;
  readonly memoryLimit?: string;
  readonly threads?: number;
  readonly sheet?: string;
  readonly recordPath?: string;
  readonly signal?: AbortSignal;
}

export interface PreparedQueryExecutionOptions extends Omit<
  QueryExecutionOptions,
  "input" | "sheet" | "recordPath"
> {
  readonly databasePath: string;
  readonly invocationDirectory: string;
}

export interface DuckDbQueryRunnerOptions {
  readonly workerPath: string | URL;
  readonly graceMs?: number;
  readonly stage?: typeof stageTabularInput;
  readonly makeTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
}

function workerError(error: Extract<QueryWorkerMessage, { type: "error" }>["error"]): KlopsiError {
  return new KlopsiError({
    code: error.code,
    message: error.message,
    exitCode: error.exitCode === 2 ? EXIT_CODES.INVALID_INPUT : EXIT_CODES.QUERY_FAILURE,
    ...(error.context === undefined ? {} : { context: error.context }),
  });
}

function queryCancelled(): KlopsiError {
  return new KlopsiError({
    code: "QUERY_CANCELLED",
    message: "The query was cancelled.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
  });
}

function queryLimits(options: PreparedQueryExecutionOptions | QueryExecutionOptions): QueryLimits {
  const memoryLimit = options.memoryLimit ?? DEFAULT_LIMITS.memoryLimit;
  if (duckDbMemoryLimitBytes(memoryLimit) === undefined)
    throw new KlopsiError({
      code: "QUERY_MEMORY_LIMIT",
      message: "DuckDB memory must be a supported positive size no larger than 1GB.",
      exitCode: EXIT_CODES.QUERY_FAILURE,
    });
  return {
    rowLimit: boundedLimit("rowLimit", options.rowLimit ?? DEFAULT_LIMITS.rowLimit),
    timeoutMs: boundedLimit("timeoutMs", options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs),
    maxSqlBytes: boundedLimit("maxSqlBytes", options.maxSqlBytes ?? DEFAULT_LIMITS.maxSqlBytes),
    maxColumns: boundedLimit("maxColumns", options.maxColumns ?? DEFAULT_LIMITS.maxColumns),
    maxCellBytes: boundedLimit("maxCellBytes", options.maxCellBytes ?? DEFAULT_LIMITS.maxCellBytes),
    maxOutputBytes: boundedLimit(
      "maxOutputBytes",
      options.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
    ),
    memoryLimit,
    threads: boundedLimit("threads", options.threads ?? DEFAULT_LIMITS.threads),
  };
}

function cleanupError(failures: readonly unknown[], operationError: unknown): KlopsiError {
  const first = failures[0];
  return new KlopsiError({
    code: "QUERY_CLEANUP_FAILED",
    message: "Query resources could not be fully cleaned up.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
    context: {
      message: first instanceof Error ? first.message : String(first),
      failureCount: failures.length,
    },
    cause: new AggregateError(
      operationError === undefined ? failures : [operationError, ...failures],
      "Query operation and cleanup failures",
    ),
  });
}

async function stopAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
}

export class DuckDbQueryRunner {
  constructor(private readonly options: DuckDbQueryRunnerOptions) {}

  async execute(options: QueryExecutionOptions): Promise<QueryResult> {
    queryLimits(options);
    validateQueryParameters(options.parameters ?? []);
    let directory: string | undefined;
    let stage: TabularStage | undefined;
    let queryResult: QueryResult | undefined;
    let operationError: unknown;
    let cancelled = options.signal?.aborted ?? false;
    const abortDuringImport = () => {
      cancelled = true;
      stage?.connection.interrupt();
    };
    options.signal?.addEventListener("abort", abortDuringImport, { once: true });
    try {
      if (cancelled) throw queryCancelled();
      directory = await (this.options.makeTemporaryDirectory?.() ??
        mkdtemp(join(tmpdir(), "klopsi-query-")));
      if (cancelled) throw queryCancelled();
      const databasePath = join(directory, "data.duckdb");
      stage = await (this.options.stage ?? stageTabularInput)({
        input: options.input,
        databasePath,
        xlsxRowsPath: join(directory, "xlsx.ndjson"),
        xlsxSharedStringsByteLimit: 64 * 1024 * 1024,
        preserveDatabaseOnClose: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
        ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
      });
      if (cancelled) throw queryCancelled();
      await stage.connection.run("CHECKPOINT");
      await stage.close();
      stage = undefined;
      if (cancelled) throw queryCancelled();

      queryResult = await this.executePrepared({
        databasePath,
        invocationDirectory: directory,
        sql: options.sql,
        ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
        ...(options.rowLimit === undefined ? {} : { rowLimit: options.rowLimit }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxSqlBytes === undefined ? {} : { maxSqlBytes: options.maxSqlBytes }),
        ...(options.maxColumns === undefined ? {} : { maxColumns: options.maxColumns }),
        ...(options.maxCellBytes === undefined ? {} : { maxCellBytes: options.maxCellBytes }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
        ...(options.threads === undefined ? {} : { threads: options.threads }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      operationError =
        cancelled || (error as Error).name === "AbortError" ? queryCancelled() : error;
    } finally {
      options.signal?.removeEventListener("abort", abortDuringImport);
      const failures: unknown[] = [];
      if (stage !== undefined) {
        try {
          await stage.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (directory !== undefined) {
        try {
          await (this.options.removeTemporaryDirectory?.(directory) ??
            rm(directory, { recursive: true, force: true }));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) operationError = cleanupError(failures, operationError);
    }
    if (operationError !== undefined) throw operationError;
    if (queryResult === undefined)
      throw new KlopsiError({
        code: "QUERY_FAILED",
        message: "The query completed without a result.",
        exitCode: EXIT_CODES.QUERY_FAILURE,
      });
    return queryResult;
  }

  async executePrepared(options: PreparedQueryExecutionOptions): Promise<QueryResult> {
    const limits = queryLimits(options);
    const parameters = validateQueryParameters(options.parameters ?? []);
    let child: ChildProcess | undefined;
    let queryResult: QueryResult | undefined;
    let operationError: unknown;
    if (options.signal?.aborted === true) throw queryCancelled();
    try {
      const request: QueryWorkerRequest = {
        databasePath: options.databasePath,
        invocationDirectory: options.invocationDirectory,
        sql: options.sql,
        ...(parameters.length === 0 ? {} : { parameters }),
        limits,
      };
      const path =
        this.options.workerPath instanceof URL
          ? fileURLToPath(this.options.workerPath)
          : this.options.workerPath;
      child = fork(path, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      queryResult = await new Promise<QueryResult>((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (killTimer !== undefined) clearTimeout(killTimer);
          options.signal?.removeEventListener("abort", abort);
          callback();
        };
        const timeout = () => {
          if (settled) return;
          timedOut = true;
          child?.kill("SIGINT");
          killTimer = setTimeout(() => child?.kill("SIGKILL"), this.options.graceMs ?? 250);
        };
        const deadline = setTimeout(timeout, limits.timeoutMs);
        const abort = () => {
          cancelled = true;
          child?.kill("SIGTERM");
          killTimer = setTimeout(() => child?.kill("SIGKILL"), this.options.graceMs ?? 250);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) abort();
        child?.once("message", (raw: QueryWorkerMessage) => {
          finish(() => {
            if (timedOut)
              reject(
                new KlopsiError({
                  code: "QUERY_TIMEOUT",
                  message: "The query exceeded its time limit.",
                  exitCode: EXIT_CODES.QUERY_FAILURE,
                }),
              );
            else if (cancelled)
              reject(
                new KlopsiError({
                  code: "QUERY_CANCELLED",
                  message: "The query was cancelled.",
                  exitCode: EXIT_CODES.QUERY_FAILURE,
                }),
              );
            else if (raw.type === "result") resolve(raw.result);
            else reject(workerError(raw.error));
          });
        });
        child?.once("error", (error) =>
          finish(() => {
            if (cancelled)
              reject(
                new KlopsiError({
                  code: "QUERY_CANCELLED",
                  message: "The query was cancelled.",
                  exitCode: EXIT_CODES.QUERY_FAILURE,
                }),
              );
            else reject(error);
          }),
        );
        child?.once("exit", (code, signal) => {
          if (!settled)
            finish(() => {
              if (timedOut)
                reject(
                  new KlopsiError({
                    code: "QUERY_TIMEOUT",
                    message: "The query exceeded its time limit.",
                    exitCode: EXIT_CODES.QUERY_FAILURE,
                  }),
                );
              else if (cancelled)
                reject(
                  new KlopsiError({
                    code: "QUERY_CANCELLED",
                    message: "The query was cancelled.",
                    exitCode: EXIT_CODES.QUERY_FAILURE,
                  }),
                );
              else
                reject(
                  new KlopsiError({
                    code: "QUERY_WORKER_EXIT",
                    message: `Query worker exited (${signal ?? code ?? "unknown"}).`,
                    exitCode: EXIT_CODES.QUERY_FAILURE,
                  }),
                );
            });
        });
        child?.send(request);
      });
    } catch (error) {
      operationError = error;
    } finally {
      const failures: unknown[] = [];
      if (child !== undefined) {
        try {
          await stopAndWait(child);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) operationError = cleanupError(failures, operationError);
    }
    if (operationError !== undefined) throw operationError;
    if (queryResult === undefined)
      throw new KlopsiError({
        code: "QUERY_FAILED",
        message: "The query completed without a result.",
        exitCode: EXIT_CODES.QUERY_FAILURE,
      });
    return queryResult;
  }
}
