import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  validateQueryParameters,
  type DataInput,
  type DataRow,
  type QueryParameter,
  type QueryResult,
} from "@klopsi/data-engine";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { publishArtifactPair, type PairPublicationOptions } from "@klopsi/storage";
import type { DataResolutionOptions, DataService } from "./data.js";
import {
  QueryDatabaseCache,
  type QueryDatabaseMetadata,
  type QueryDatabaseWarning,
  type QueryCacheMetadata,
} from "./query-database-cache.js";

export interface QueryServiceOptions extends DataResolutionOptions {
  readonly sql: string;
  /** Named `$name` parameters bound through DuckDB prepared statements, never interpolated. */
  readonly parameters?: readonly QueryParameter[];
  readonly limit?: number;
  readonly timeoutMs?: number;
  readonly memoryLimit?: string;
  readonly threads?: number;
  readonly sheet?: string;
  readonly recordPath?: string;
  readonly output?: string;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface QueryServiceResult extends QueryResult {
  /** Bound parameters; present only when at least one parameter was supplied. */
  readonly parameters?: readonly QueryParameter[];
  readonly source: string;
  readonly durationMs: number;
  readonly cache: QueryCacheMetadata;
  readonly warnings: readonly QueryDatabaseWarning[];
  readonly output?: string;
  readonly provenancePath?: string;
}

export interface QueryDatabaseServiceOptions extends DataResolutionOptions {
  readonly sheet?: string;
  readonly signal?: AbortSignal;
}

export interface QueryDatabaseServiceResult<T> extends QueryDatabaseMetadata {
  readonly value: T;
  readonly source: string;
}

async function digest(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.from(raw as Uint8Array);
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function cell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.includes(delimiter) || /["\r\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function serialize(rows: readonly DataRow[], columns: readonly string[], output: string): string {
  const format = extname(output).toLowerCase();
  if (format === ".json") return `${JSON.stringify(rows)}\n`;
  if (format === ".ndjson")
    return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  if (format !== ".csv" && format !== ".tsv")
    throw new KlopsiError({
      code: "QUERY_OUTPUT_FORMAT",
      message: "Query output must end in .csv, .tsv, .json, or .ndjson.",
      exitCode: EXIT_CODES.QUERY_FAILURE,
    });
  const delimiter = format === ".csv" ? "," : "\t";
  if (columns.length === 0) return "";
  return `${[columns.join(delimiter), ...rows.map((row) => columns.map((column) => cell(row[column], delimiter)).join(delimiter))].join("\n")}\n`;
}

async function publishQueryOutput(
  input: string,
  output: string,
  sql: string,
  parameters: readonly QueryParameter[],
  rows: readonly DataRow[],
  columns: readonly string[],
  force: boolean,
  publicationOptions: PairPublicationOptions = {},
) {
  const destination = resolve(output);
  const temp = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const provenancePath = `${destination}.provenance.json`;
  const provenanceTemp = `${provenancePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(serialize(rows, columns, destination));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const [sourceDigest, outputDigest] = await Promise.all([digest(input), digest(temp)]);
    const provenance = {
      schemaVersion: "1",
      retrievedAt: new Date().toISOString(),
      ...outputDigest,
      localPath: destination,
      transformations: [
        {
          operation: "query",
          timestamp: new Date().toISOString(),
          inputSha256: sourceDigest.sha256,
          details: { sql, ...(parameters.length === 0 ? {} : { parameters }) },
        },
      ],
    };
    const sidecar = await open(provenanceTemp, "wx", 0o600);
    try {
      await sidecar.writeFile(`${JSON.stringify(provenance, null, 2)}\n`);
      await sidecar.sync();
    } finally {
      await sidecar.close();
    }
    return await publishArtifactPair(temp, provenanceTemp, destination, {
      ...publicationOptions,
      force,
      existsCode: "QUERY_DESTINATION_EXISTS",
      existsExitCode: EXIT_CODES.QUERY_FAILURE,
    });
  } catch (error) {
    await Promise.all([rm(temp, { force: true }), rm(provenanceTemp, { force: true })]);
    throw error;
  }
}

function sourcePath(input: DataInput): string {
  return typeof input === "string" ? input : input.path;
}

export class QueryService {
  constructor(
    private readonly data: DataService,
    private readonly databases: QueryDatabaseCache,
    private readonly publicationOptions: PairPublicationOptions = {},
  ) {}

  withDatabase<T>(
    input: string,
    options: QueryDatabaseServiceOptions,
    operation: (databasePath: string, metadata: QueryDatabaseMetadata) => Promise<T>,
  ): Promise<QueryDatabaseServiceResult<T>> {
    return this.data.withResolvedInput(input, options, async (source) => {
      const leased = await this.databases.withDatabase(
        source,
        {
          ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
          ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        operation,
      );
      return {
        ...leased,
        source: resolve(sourcePath(source)),
      };
    });
  }

  async execute(input: string, options: QueryServiceOptions): Promise<QueryServiceResult> {
    const parameters = validateQueryParameters(options.parameters ?? []);
    return this.data.withResolvedInput(input, options, async (source) => {
      const started = performance.now();
      const result = await this.databases.execute(source, {
        sql: options.sql,
        ...(parameters.length === 0 ? {} : { parameters }),
        ...(options.limit === undefined ? {} : { rowLimit: options.limit }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
        ...(options.threads === undefined ? {} : { threads: options.threads }),
        ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
        ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const sourceName = resolve(sourcePath(source));
      const publication =
        options.output === undefined
          ? {}
          : await publishQueryOutput(
              sourceName,
              options.output,
              options.sql,
              parameters,
              result.rows,
              result.columns,
              options.force ?? false,
              this.publicationOptions,
            );
      return {
        ...result,
        ...(parameters.length === 0 ? {} : { parameters }),
        source: sourceName,
        durationMs: performance.now() - started,
        ...publication,
      };
    });
  }
}
