import type { QueryParameter } from "./query-parameters.js";
import type { DataRow } from "./types.js";

export interface QueryLimits {
  readonly rowLimit: number;
  readonly timeoutMs: number;
  readonly maxSqlBytes: number;
  readonly maxColumns: number;
  readonly maxCellBytes: number;
  readonly maxOutputBytes: number;
  readonly memoryLimit: string;
  readonly threads: number;
}

export interface QueryWorkerRequest {
  readonly databasePath: string;
  readonly invocationDirectory: string;
  readonly sql: string;
  /** Named `$name` parameters bound to the prepared statement, never interpolated. */
  readonly parameters?: readonly QueryParameter[];
  readonly limits: QueryLimits;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly DataRow[];
  readonly returnedCount: number;
  readonly truncated: boolean;
  readonly sql: string;
}

export type QueryWorkerMessage =
  | { readonly type: "result"; readonly result: QueryResult }
  | {
      readonly type: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly exitCode: 2 | 7;
        readonly context?: Readonly<Record<string, unknown>>;
      };
    };
