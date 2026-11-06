import { availableParallelism } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { DuckDBInstance, DuckDBConnection, DuckDBPreparedStatement } from "@duckdb/node-api";
import { duckDbMemoryLimitBytes } from "@klopsi/domain";
import type {
  QueryLimits,
  QueryResult,
  QueryWorkerMessage,
  QueryWorkerRequest,
} from "./query-protocol.js";

interface WorkerError extends Error {
  readonly code?: string;
  readonly exitCode?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface QueryWorkerResources {
  readonly prepared: Pick<DuckDBPreparedStatement, "destroySync"> | undefined;
  readonly connection: Pick<DuckDBConnection, "closeSync"> | undefined;
  readonly instance: Pick<DuckDBInstance, "closeSync"> | undefined;
}

let activeConnection: DuckDBConnection | undefined;

function failure(
  code: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): WorkerError {
  return Object.assign(new Error(message), {
    code,
    exitCode: 7,
    ...(context === undefined ? {} : { context }),
  });
}

export function finalizeQueryWorkerResources(
  resources: QueryWorkerResources,
  operationError?: unknown,
): void {
  const failures: unknown[] = [];
  for (const close of [
    resources.prepared === undefined ? undefined : () => resources.prepared?.destroySync(),
    resources.connection === undefined ? undefined : () => resources.connection?.closeSync(),
    resources.instance === undefined ? undefined : () => resources.instance?.closeSync(),
  ]) {
    if (close === undefined) continue;
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const error = failure(
      "QUERY_CLEANUP_FAILED",
      "Query worker resources could not be fully closed.",
      {
        failureCount: failures.length,
        ...(operationError instanceof Error ? { operationMessage: operationError.message } : {}),
      },
    );
    Object.assign(error, {
      cause: new AggregateError(
        operationError === undefined ? failures : [operationError, ...failures],
        "Query execution and worker cleanup failures",
      ),
    });
    throw error;
  }
  if (operationError !== undefined) throw operationError;
}

function cellBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function diagnosticForbiddenToken(sql: string): boolean {
  const withoutLeadingComments = sql.replace(
    /^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u,
    "",
  );
  return /^(?:PRAGMA|COPY|ATTACH|DETACH|INSTALL|FORCE\s+INSTALL|LOAD|SET|CALL|CREATE|DROP|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|EXPORT|EXPLAIN)\b/iu.test(
    withoutLeadingComments,
  );
}

async function validateAndPrepare(connection: DuckDBConnection, sql: string, limits: QueryLimits) {
  if (Buffer.byteLength(sql, "utf8") > limits.maxSqlBytes)
    throw failure("QUERY_SQL_TOO_LARGE", `SQL exceeds the ${limits.maxSqlBytes}-byte limit.`);
  if (sql.trim().length === 0) throw failure("QUERY_FORBIDDEN", "A SELECT query is required.");
  if (diagnosticForbiddenToken(sql))
    throw failure("QUERY_FORBIDDEN", "This statement is not allowed in a read-only query.");
  const extracted = await connection.extractStatements(sql);
  if (extracted.count !== 1)
    throw failure("QUERY_FORBIDDEN", "Exactly one SELECT statement is allowed.");
  const prepared = await extracted.prepare(0);
  if (prepared.statementType !== 1) {
    prepared.destroySync();
    throw failure("QUERY_FORBIDDEN", "Only SELECT, WITH ... SELECT, or VALUES is allowed.");
  }
  return prepared;
}

export async function executeQueryWorker(request: QueryWorkerRequest): Promise<QueryResult> {
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  let prepared: DuckDBPreparedStatement | undefined;
  let queryResult: QueryResult | undefined;
  let operationError: unknown;
  try {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    if (duckDbMemoryLimitBytes(request.limits.memoryLimit) === undefined)
      throw failure("QUERY_MEMORY_LIMIT", "DuckDB memory must not exceed 1GB.");
    instance = await DuckDBInstance.create(request.databasePath, {
      access_mode: "READ_ONLY",
      enable_external_access: "false",
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      allow_community_extensions: "false",
      allow_unsigned_extensions: "false",
      threads: String(Math.min(4, availableParallelism(), request.limits.threads)),
      memory_limit: request.limits.memoryLimit,
      max_temp_directory_size: "1GB",
      max_expression_depth: "500",
      lock_configuration: "true",
    });
    connection = await instance.connect();
    activeConnection = connection;
    const settings = await connection.runAndReadAll(
      "SELECT current_setting('temp_directory') AS path",
    );
    const configuredTemp = settings.getRowObjectsJS()[0]?.path;
    const relativeTemp =
      typeof configuredTemp === "string"
        ? relative(resolve(request.invocationDirectory), resolve(configuredTemp))
        : "..";
    if (
      typeof configuredTemp !== "string" ||
      relativeTemp === ".." ||
      relativeTemp.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeTemp)
    )
      throw failure("QUERY_TEMP_ISOLATION", "DuckDB's spill directory escaped query isolation.");
    prepared = await validateAndPrepare(connection, request.sql, request.limits);
    if (prepared.columnCount > request.limits.maxColumns)
      throw failure(
        "QUERY_COLUMN_LIMIT",
        `Query returns more than ${request.limits.maxColumns} columns.`,
      );
    const result = await prepared.stream();
    const columns = Array.from({ length: result.columnCount }, (_, index) =>
      result.columnName(index),
    );
    const rows: Record<string, unknown>[] = [];
    let outputBytes = 0;
    outer: for await (const batch of result.yieldRowObjectJson()) {
      for (const row of batch) {
        for (const [column, value] of Object.entries(row)) {
          const bytes = cellBytes(value);
          if (bytes > request.limits.maxCellBytes)
            throw failure(
              "QUERY_CELL_LIMIT",
              `A query cell exceeds the ${request.limits.maxCellBytes}-byte limit.`,
              { column },
            );
        }
        outputBytes += Buffer.byteLength(JSON.stringify(row), "utf8");
        if (outputBytes > request.limits.maxOutputBytes)
          throw failure(
            "QUERY_OUTPUT_LIMIT",
            `Query output exceeds the ${request.limits.maxOutputBytes}-byte limit.`,
          );
        rows.push(row);
        if (rows.length > request.limits.rowLimit) break outer;
      }
    }
    queryResult = {
      columns,
      rows: rows.slice(0, request.limits.rowLimit),
      returnedCount: Math.min(rows.length, request.limits.rowLimit),
      truncated: rows.length > request.limits.rowLimit,
      sql: request.sql,
    };
  } catch (error) {
    operationError = error;
  } finally {
    activeConnection = undefined;
  }
  finalizeQueryWorkerResources({ prepared, connection, instance }, operationError);
  if (queryResult === undefined)
    throw failure("QUERY_FAILED", "The query worker completed without a result.");
  return queryResult;
}

/** Resolve only after the IPC channel accepted the message, so disconnect cannot drop it. */
function send(message: QueryWorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, undefined, {}, () => resolve());
  });
}

export function startQueryWorker(): void {
  if (process.send === undefined) throw new Error("The query worker requires an IPC channel.");
  const interrupt = () => activeConnection?.interrupt();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  process.once("message", (raw: QueryWorkerRequest) => {
    void executeQueryWorker(raw)
      .then(
        (result) => send({ type: "result", result }),
        (rawError: unknown) => {
          const error = rawError as WorkerError;
          send({
            type: "error",
            error: {
              code: error.code ?? "QUERY_FAILED",
              message: error.message ?? String(rawError),
              exitCode: 7,
              ...(error.context === undefined ? {} : { context: error.context }),
            },
          });
        },
      )
      .finally(() => {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        process.disconnect();
      });
  });
}
