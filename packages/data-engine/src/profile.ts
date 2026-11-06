import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import type { DuckDbQueryRunner, PreparedQueryExecutionOptions } from "./query.js";
import type { DataRow } from "./types.js";
import { sqlIdentifier } from "./sql-path.js";

/** Statistics for one column of the staged KLOPSI-owned `data` table. */
export interface ColumnProfile {
  readonly column: string;
  /** DuckDB logical type of the staged column, for example `BIGINT` or `VARCHAR`. */
  readonly type: string;
  /** Number of non-null values. */
  readonly count: number;
  readonly nullCount: number;
  /** Percentage of null values rounded to two decimals; `null` for an empty table. */
  readonly nullPercent: number | null;
  /** HyperLogLog estimate of distinct non-null values, never larger than `count`. */
  readonly distinctApprox: number;
  /**
   * Smallest value rendered as text and capped at 256 characters; `null` for
   * nested types or when every value is null. TIMESTAMPTZ values are in UTC.
   */
  readonly min: string | null;
  /** Whether `min` was cut to {@link PROFILE_TEXT_LIMIT} characters. */
  readonly minTruncated: boolean;
  /** Largest value, rendered like `min`. */
  readonly max: string | null;
  /** Whether `max` was cut to {@link PROFILE_TEXT_LIMIT} characters. */
  readonly maxTruncated: boolean;
  /**
   * Arithmetic mean of numeric columns; `null` otherwise. For FLOAT and DOUBLE
   * columns, NaN, infinities, and magnitudes of 1e150 or more are excluded.
   */
  readonly mean: number | null;
  /** Sample standard deviation of numeric columns over the same values as `mean`. */
  readonly stddev: number | null;
}

export interface ProfileResult {
  readonly rowCount: number;
  readonly columns: readonly ColumnProfile[];
}

export interface ProfileColumn {
  readonly name: string;
  readonly type: string;
}

export interface ProfileBatch {
  readonly columns: readonly ProfileColumn[];
  readonly sql: string;
}

export interface ProfileExecutionOptions extends Pick<
  PreparedQueryExecutionOptions,
  "databasePath" | "invocationDirectory" | "timeoutMs" | "memoryLimit" | "threads" | "signal"
> {
  /** Monotonic clock used for the shared deadline; injectable for tests. */
  readonly now?: () => number;
}

type PreparedRunner = Pick<DuckDbQueryRunner, "executePrepared">;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BATCH_COLUMNS = 200;
const MAX_BATCH_SQL_BYTES = 60 * 1024;
const MAX_PROFILE_COLUMNS = 16_384;

// KLOPSI-owned statement: no user input is interpolated.
export const PROFILE_SCHEMA_SQL =
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'data' ORDER BY ordinal_position";

const NUMERIC_TYPE =
  /^(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL\(\d+,\s*\d+\))$/u;
const FLOAT_TYPE = /^(?:FLOAT|DOUBLE)$/u;
const NESTED_TYPE = /^(?:STRUCT|MAP|UNION)\(|\]$/u;
const TIMESTAMPTZ_TYPE = /^TIMESTAMP WITH TIME ZONE$/u;

/** Maximum characters of `min` and `max` text returned per column. */
export const PROFILE_TEXT_LIMIT = 256;
/** Float magnitudes at or above this bound are excluded so variance cannot overflow. */
const FLOAT_MAGNITUDE_LIMIT = "1e150";
// KLOPSI-owned statement used when the staged table has no columns to batch.
const ROW_COUNT_SQL = "SELECT count(*) AS row_count FROM data";

function sqlTooLarge(): KlopsiError {
  return new KlopsiError({
    code: "QUERY_SQL_TOO_LARGE",
    message: "A column name is too long to profile within the SQL size limit.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
  });
}

function timeout(): KlopsiError {
  return new KlopsiError({
    code: "QUERY_TIMEOUT",
    message: "The query exceeded its time limit.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
  });
}

function cancelled(): KlopsiError {
  return new KlopsiError({
    code: "QUERY_CANCELLED",
    message: "The query was cancelled.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
  });
}

function malformed(message: string): KlopsiError {
  return new KlopsiError({
    code: "QUERY_FAILED",
    message,
    exitCode: EXIT_CODES.QUERY_FAILURE,
  });
}

function extreme(column: ProfileColumn, operation: "min" | "max", alias: string): string {
  // TIMESTAMPTZ text otherwise depends on the worker's host timezone.
  return TIMESTAMPTZ_TYPE.test(column.type)
    ? `(CAST(timezone('UTC', ${operation}(${alias})) AS VARCHAR) || '+00')`
    : `CAST(${operation}(${alias}) AS VARCHAR)`;
}

function aggregate(column: ProfileColumn, alias: string, output: string): string {
  const nested = NESTED_TYPE.test(column.type);
  const numeric = NUMERIC_TYPE.test(column.type);
  const value = `CAST(${alias} AS DOUBLE)`;
  const filter = FLOAT_TYPE.test(column.type)
    ? ` FILTER (WHERE isfinite(${value}) AND abs(${value}) < ${FLOAT_MAGNITUDE_LIMIT})`
    : "";
  const text = (key: string, operation: "min" | "max") =>
    nested
      ? [`'${key}': NULL::VARCHAR`, `'${key}t': false`]
      : [
          `'${key}': left(${extreme(column, operation, alias)}, ${PROFILE_TEXT_LIMIT})`,
          `'${key}t': coalesce(length(${extreme(column, operation, alias)}) > ${PROFILE_TEXT_LIMIT}, false)`,
        ];
  return [
    `{'n': count(${alias})`,
    `'d': approx_count_distinct(${alias})`,
    ...text("mn", "min"),
    ...text("mx", "max"),
    numeric ? `'av': avg(${value})${filter}` : "'av': NULL::DOUBLE",
    numeric ? `'sd': stddev_samp(${value})${filter}` : "'sd': NULL::DOUBLE",
  ]
    .join(", ")
    .concat(`} AS ${output}`);
}

function batchSql(projections: readonly string[], aggregates: readonly string[]): string {
  return `WITH t AS (SELECT ${projections.join(", ")} FROM data) SELECT count(*) AS row_count, ${aggregates.join(", ")} FROM t`;
}

/**
 * Build KLOPSI-owned single-SELECT statements that profile the staged `data`
 * table. Column names are only ever emitted as quoted identifiers and the
 * output aliases are positional, so arbitrary names cannot change the SQL shape.
 */
export function buildProfileBatches(columns: readonly ProfileColumn[]): readonly ProfileBatch[] {
  const batches: ProfileBatch[] = [];
  let current: ProfileColumn[] = [];
  let projections: string[] = [];
  let aggregates: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    batches.push({ columns: current, sql: batchSql(projections, aggregates) });
    current = [];
    projections = [];
    aggregates = [];
  };
  const fragments = (column: ProfileColumn, index: number) =>
    [
      `${sqlIdentifier(column.name)} AS c${index}`,
      aggregate(column, `c${index}`, `p${index}`),
    ] as const;
  const fits = (projection: string, statistics: string) =>
    Buffer.byteLength(batchSql([...projections, projection], [...aggregates, statistics])) <=
    MAX_BATCH_SQL_BYTES;
  for (const column of columns) {
    let [projection, statistics] = fragments(column, current.length);
    if (!fits(projection, statistics)) {
      if (current.length === 0) throw sqlTooLarge();
      flush();
      [projection, statistics] = fragments(column, 0);
      if (!fits(projection, statistics)) throw sqlTooLarge();
    }
    current.push(column);
    projections.push(projection);
    aggregates.push(statistics);
    if (current.length >= MAX_BATCH_COLUMNS) flush();
  }
  flush();
  return batches;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw malformed(`The profile returned an invalid ${field}.`);
  return parsed;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statistics(column: ProfileColumn, raw: unknown, rowCount: number): ColumnProfile {
  if (raw === null || typeof raw !== "object") throw malformed("The profile row is malformed.");
  const value = raw as Record<string, unknown>;
  const count = integer(value.n, "count");
  const nullCount = rowCount - count;
  return {
    column: column.name,
    type: column.type,
    count,
    nullCount,
    nullPercent: rowCount === 0 ? null : Math.round((nullCount / rowCount) * 10_000) / 100,
    distinctApprox: Math.min(integer(value.d, "distinct count"), count),
    min: text(value.mn),
    minTruncated: value.mnt === true,
    max: text(value.mx),
    maxTruncated: value.mxt === true,
    mean: finite(value.av),
    stddev: finite(value.sd),
  };
}

function schemaColumns(rows: readonly DataRow[]): readonly ProfileColumn[] {
  return rows.map((row) => {
    if (typeof row.column_name !== "string" || typeof row.data_type !== "string")
      throw malformed("The staged table schema is malformed.");
    return { name: row.column_name, type: row.data_type };
  });
}

/**
 * Profile the staged `data` table through the sandboxed query worker. Every
 * statement runs under the same read-only worker policy as `klopsi query`, and
 * all statements share one deadline.
 */
export async function profileStagedDatabase(
  runner: PreparedRunner,
  options: ProfileExecutionOptions,
): Promise<ProfileResult> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const run = async (sql: string, rowLimit: number, maxColumns: number) => {
    if (options.signal?.aborted === true) throw cancelled();
    const remaining = Math.ceil(deadline - now());
    if (remaining <= 0) throw timeout();
    return runner.executePrepared({
      databasePath: options.databasePath,
      invocationDirectory: options.invocationDirectory,
      sql,
      rowLimit,
      maxColumns,
      timeoutMs: remaining,
      ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
      ...(options.threads === undefined ? {} : { threads: options.threads }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };

  const schema = await run(PROFILE_SCHEMA_SQL, MAX_PROFILE_COLUMNS, 2);
  if (schema.truncated)
    throw new KlopsiError({
      code: "QUERY_COLUMN_LIMIT",
      message: `The staged table has more than ${MAX_PROFILE_COLUMNS} columns to profile.`,
      exitCode: EXIT_CODES.QUERY_FAILURE,
    });
  const columns = schemaColumns(schema.rows);
  const profiles: ColumnProfile[] = [];
  const batches = buildProfileBatches(columns);
  if (batches.length === 0) {
    const counted = await run(ROW_COUNT_SQL, 1, 1);
    return { rowCount: integer(counted.rows[0]?.row_count, "row count"), columns: [] };
  }
  let rowCount = 0;
  for (const batch of batches) {
    const result = await run(batch.sql, 1, batch.columns.length + 1);
    const row = result.rows[0];
    if (row === undefined) throw malformed("The profile query returned no rows.");
    rowCount = integer(row.row_count, "row count");
    batch.columns.forEach((column, index) =>
      profiles.push(statistics(column, row[`p${index}`], rowCount)),
    );
  }
  return { rowCount, columns: profiles };
}
