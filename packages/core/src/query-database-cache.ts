import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PCAXIS_LIMITS,
  detectFormat,
  stageTabularInput,
  verifyStagedDatabase,
  type DataInput,
  type DuckDbQueryRunner,
  type PreparedQueryExecutionOptions,
  type PcAxisLimits,
  type QueryResult,
  type SupportedInputFormat,
  type TabularStage,
  type ValidationIssue,
} from "@klopsi/data-engine";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import type { DerivedArtifactCache, DerivedArtifactIdentity } from "@klopsi/storage";

export const QUERY_STAGE_VERSION = "3";
export const QUERY_STAGE_DUCKDB_VERSION = "1.5.4-r.1";

export type QueryCacheStatus = "hit" | "miss" | "bypass";

export interface QueryCacheMetadata {
  readonly status: QueryCacheStatus;
  readonly kind: "duckdb-stage";
}

export interface QueryCacheWarning {
  readonly code: "QUERY_CACHE_BYPASS";
  readonly message: string;
}

export type QueryDatabaseWarning = QueryCacheWarning | ValidationIssue;

type PreparedRunner = Pick<DuckDbQueryRunner, "executePrepared">;
type DerivedCache = Pick<
  DerivedArtifactCache,
  "key" | "list" | "materialize" | "publish" | "withBuildLock" | "policy"
>;
export type QueryDatabaseExecutionOptions = Omit<
  PreparedQueryExecutionOptions,
  "databasePath" | "invocationDirectory"
> & { readonly sheet?: string; readonly recordPath?: string };
export type QueryDatabasePreparationOptions = Pick<
  QueryDatabaseExecutionOptions,
  "sheet" | "recordPath" | "signal"
>;

export interface QueryDatabaseCacheOptions {
  readonly derived?: DerivedCache;
  readonly runner: PreparedRunner;
  readonly stage?: typeof stageTabularInput;
  readonly verify?: typeof verifyStagedDatabase;
  readonly makeTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
  readonly xmlLimits?: import("@klopsi/data-engine").XmlLimits;
  readonly pcAxisLimits?: PcAxisLimits;
}

export interface QueryDatabaseResult extends QueryResult {
  readonly cache: QueryCacheMetadata;
  readonly warnings: readonly QueryDatabaseWarning[];
}

export interface QueryDatabaseMetadata {
  readonly cache: QueryCacheMetadata;
  readonly warnings: readonly QueryDatabaseWarning[];
}

export interface QueryDatabaseLeaseResult<T> extends QueryDatabaseMetadata {
  readonly value: T;
}

async function sourceDigest(input: DataInput, path: string): Promise<string> {
  if (
    typeof input !== "string" &&
    input.sha256 !== undefined &&
    /^[a-f\d]{64}$/u.test(input.sha256)
  )
    return input.sha256;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

function supported(format: string): format is SupportedInputFormat {
  return ["csv", "tsv", "json", "ndjson", "xlsx", "parquet", "xml", "pcaxis"].includes(format);
}

function pcAxisStageVersion(limits: PcAxisLimits | undefined): string {
  const effective = { ...DEFAULT_PCAXIS_LIMITS, ...limits };
  const canonical = JSON.stringify(
    Object.entries(effective).sort(([left], [right]) => left.localeCompare(right)),
  );
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${QUERY_STAGE_VERSION}:pcaxis:${digest}`;
}

function cleanupFailure(failures: readonly unknown[], operationError: unknown): KlopsiError {
  return new KlopsiError({
    code: "QUERY_CLEANUP_FAILED",
    message: "Query resources could not be fully cleaned up.",
    exitCode: EXIT_CODES.QUERY_FAILURE,
    context: { failureCount: failures.length },
    cause: new AggregateError(
      operationError === undefined ? failures : [operationError, ...failures],
      "Query operation and cleanup failures",
    ),
  });
}

export class QueryDatabaseCache {
  constructor(private readonly options: QueryDatabaseCacheOptions) {}

  async withDatabase<T>(
    source: DataInput,
    options: QueryDatabasePreparationOptions,
    operation: (databasePath: string, metadata: QueryDatabaseMetadata) => Promise<T>,
  ): Promise<QueryDatabaseLeaseResult<T>> {
    let directory: string | undefined;
    let stage: TabularStage | undefined;
    let result: T | undefined;
    let operationCompleted = false;
    let status: QueryCacheStatus = "bypass";
    let operationError: unknown;
    const cacheWarnings: QueryCacheWarning[] = [];
    let stagingWarnings: readonly ValidationIssue[] = [];
    const warn = () => {
      if (!cacheWarnings.some((warning) => warning.code === "QUERY_CACHE_BYPASS"))
        cacheWarnings.push({
          code: "QUERY_CACHE_BYPASS",
          message: "DuckDB stage caching was unavailable; the query used temporary staging.",
        });
    };
    try {
      directory = await (this.options.makeTemporaryDirectory?.() ??
        mkdtemp(join(tmpdir(), "klopsi-query-")));
      const databasePath = join(directory, "data.duckdb");
      const detection = await detectFormat(source);
      if (!supported(detection.format))
        throw new KlopsiError({
          code: "UNSUPPORTED_CONVERSION_FORMAT",
          message: `The detected format '${detection.format}' cannot be converted.`,
          exitCode: EXIT_CODES.UNSUPPORTED,
          suggestion: "Use CSV, TSV, JSON, NDJSON, XLSX, Parquet, XML, or PC-Axis input.",
          context: { format: detection.format },
        });
      const build = async (): Promise<void> => {
        stage = await (this.options.stage ?? stageTabularInput)({
          input: source,
          detection,
          databasePath,
          xlsxRowsPath: join(directory as string, "xlsx.ndjson"),
          xlsxSharedStringsByteLimit: 64 * 1024 * 1024,
          preserveDatabaseOnClose: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
          ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
          ...(this.options.xmlLimits === undefined ? {} : { xmlLimits: this.options.xmlLimits }),
          ...(this.options.pcAxisLimits === undefined
            ? {}
            : { pcAxisLimits: this.options.pcAxisLimits }),
        });
        const builtWarnings = stage.warnings;
        await stage.connection.run("CHECKPOINT");
        await stage.close();
        stage = undefined;
        stagingWarnings = builtWarnings;
        await (this.options.verify ?? verifyStagedDatabase)(databasePath);
      };

      const derived = this.options.derived;
      const cacheEnabled =
        detection.format !== "xml" &&
        derived !== undefined &&
        derived.policy.enabled &&
        derived.policy.maxBytes > 0;
      if (!cacheEnabled) {
        await build();
      } else {
        const identity: DerivedArtifactIdentity = {
          kind: "duckdb-stage",
          sourceSha256: await sourceDigest(source, detection.path),
          format: detection.format as Exclude<SupportedInputFormat, "xml">,
          ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
          stagingVersion:
            detection.format === "pcaxis"
              ? pcAxisStageVersion(this.options.pcAxisLimits)
              : QUERY_STAGE_VERSION,
          duckdbVersion: QUERY_STAGE_DUCKDB_VERSION,
        };
        let lookupFailed = false;
        try {
          const hit = await derived.materialize(identity, databasePath);
          if (hit !== undefined) {
            await (this.options.verify ?? verifyStagedDatabase)(databasePath);
            status = "hit";
          }
        } catch {
          warn();
          try {
            await (this.options.verify ?? verifyStagedDatabase)(databasePath);
            status = "hit";
          } catch {
            lookupFailed = true;
            await rm(databasePath, { force: true });
          }
        }
        if (status !== "hit" && lookupFailed) {
          await build();
        } else if (status !== "hit") {
          let stagingError: unknown;
          try {
            await derived.withBuildLock(identity, async () => {
              try {
                const hit = await derived.materialize(identity, databasePath);
                if (hit !== undefined) {
                  await (this.options.verify ?? verifyStagedDatabase)(databasePath);
                  status = "hit";
                  return;
                }
              } catch {
                warn();
                try {
                  await (this.options.verify ?? verifyStagedDatabase)(databasePath);
                  status = "hit";
                  return;
                } catch {
                  await rm(databasePath, { force: true });
                }
              }
              try {
                await build();
              } catch (error) {
                stagingError = error;
                throw error;
              }
              if (stagingWarnings.length > 0) {
                status = "bypass";
                return;
              }
              try {
                const publication = await derived.publish(identity, databasePath);
                status = publication.retained ? "miss" : "bypass";
              } catch {
                warn();
                try {
                  const key = derived.key(identity);
                  status = (await derived.list()).some((entry) => entry.key === key)
                    ? "miss"
                    : "bypass";
                } catch {
                  status = "bypass";
                }
              }
            });
          } catch {
            if (stagingError !== undefined) throw stagingError;
            warn();
            await rm(databasePath, { force: true });
            await build();
            status = "bypass";
          }
        }
      }

      const warnings: readonly QueryDatabaseWarning[] = [...cacheWarnings, ...stagingWarnings];
      result = await operation(databasePath, {
        cache: { status, kind: "duckdb-stage" },
        warnings,
      });
      operationCompleted = true;
    } catch (error) {
      operationError = error;
    } finally {
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
      if (failures.length > 0) operationError = cleanupFailure(failures, operationError);
    }
    if (operationError !== undefined) throw operationError;
    if (!operationCompleted)
      throw new KlopsiError({
        code: "QUERY_FAILED",
        message: "The staged database operation completed without a result.",
        exitCode: EXIT_CODES.QUERY_FAILURE,
      });
    return {
      value: result as T,
      cache: { status, kind: "duckdb-stage" },
      warnings: [...cacheWarnings, ...stagingWarnings],
    };
  }

  async execute(
    source: DataInput,
    options: QueryDatabaseExecutionOptions,
  ): Promise<QueryDatabaseResult> {
    const leased = await this.withDatabase(source, options, async (databasePath) =>
      this.options.runner.executePrepared({
        databasePath,
        invocationDirectory: dirname(databasePath),
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
      }),
    );
    return { ...leased.value, cache: leased.cache, warnings: leased.warnings };
  }
}
