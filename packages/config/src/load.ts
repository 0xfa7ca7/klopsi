import { readFile } from "node:fs/promises";
import type { ConfigPaths } from "./paths.js";
import { resolveConfigPaths } from "./paths.js";
import {
  invalidConfiguration,
  parseConfiguration,
  parseConfigurationSource,
  type ConfigurationSource,
  type KlopsiConfiguration,
  type OutputFormat,
} from "./schema.js";

export interface CliConfigurationOptions {
  readonly provider?: string;
  readonly output?: OutputFormat;
  readonly offline?: boolean;
  readonly cacheDir?: string;
  readonly downloadDir?: string;
  readonly httpTimeoutMs?: number;
  readonly httpRetries?: number;
  readonly maxDownloadBytes?: number;
  readonly previewRowLimit?: number;
  readonly queryRowLimit?: number;
  readonly queryTimeoutMs?: number;
  readonly duckdbMemoryLimit?: string;
  readonly duckdbThreads?: number;
  readonly color?: boolean;
}

export interface LoadConfigurationOptions {
  readonly cwd?: string;
  readonly home?: string;
  readonly paths?: ConfigPaths;
  readonly env?: NodeJS.ProcessEnv;
  readonly cli?: CliConfigurationOptions;
}

type MutableRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(target: MutableRecord, source: Readonly<Record<string, unknown>>): MutableRecord {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    target[key] = isRecord(current) && isRecord(value) ? merge({ ...current }, value) : value;
  }
  return target;
}

async function readSource(path: string): Promise<ConfigurationSource> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw invalidConfiguration(error);
  }

  try {
    return parseConfigurationSource(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidConfiguration(error);
    throw error;
  }
}

function positiveInteger(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/u.test(value) && Number(value) > 0 ? Number(value) : value;
}

function nonnegativeInteger(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/u.test(value) ? Number(value) : value;
}

function booleanValue(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return value;
}

function environmentSource(env: NodeJS.ProcessEnv): MutableRecord {
  return {
    provider: env.KLOPSI_PROVIDER,
    output: env.KLOPSI_OUTPUT,
    offline: booleanValue(env.KLOPSI_OFFLINE),
    paths: {
      cacheDir: env.KLOPSI_CACHE_DIR,
      downloadDir: env.KLOPSI_DOWNLOAD_DIR,
    },
    http: {
      timeoutMs: positiveInteger(env.KLOPSI_HTTP_TIMEOUT_MS),
      maxDownloadBytes: positiveInteger(env.KLOPSI_MAX_DOWNLOAD_BYTES),
      retries: nonnegativeInteger(env.KLOPSI_HTTP_RETRIES),
    },
    query: {
      rowLimit: positiveInteger(env.KLOPSI_QUERY_ROW_LIMIT),
      timeoutMs: positiveInteger(env.KLOPSI_QUERY_TIMEOUT_MS),
    },
    duckdb: {
      memoryLimit: env.KLOPSI_DUCKDB_MEMORY_LIMIT,
      cache: {
        enabled: booleanValue(env.KLOPSI_DUCKDB_CACHE_ENABLED),
        maxBytes: env.KLOPSI_DUCKDB_CACHE_MAX_BYTES,
        ttlDays: positiveInteger(env.KLOPSI_DUCKDB_CACHE_TTL_DAYS),
      },
    },
    apiKey: env.OPSI_API_KEY,
  };
}

function cliSource(cli: CliConfigurationOptions): MutableRecord {
  return {
    provider: cli.provider,
    output: cli.output,
    offline: cli.offline,
    paths: { cacheDir: cli.cacheDir, downloadDir: cli.downloadDir },
    http: {
      timeoutMs: cli.httpTimeoutMs,
      maxDownloadBytes: cli.maxDownloadBytes,
      retries: cli.httpRetries,
    },
    preview: { rowLimit: cli.previewRowLimit },
    query: { rowLimit: cli.queryRowLimit, timeoutMs: cli.queryTimeoutMs },
    duckdb: { memoryLimit: cli.duckdbMemoryLimit, threads: cli.duckdbThreads },
    terminal: { color: cli.color },
  };
}

export async function loadConfiguration(
  options: LoadConfigurationOptions = {},
): Promise<KlopsiConfiguration> {
  const paths =
    options.paths ??
    resolveConfigPaths({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.home === undefined ? {} : { home: options.home }),
    });
  const runtimeEnv = options.env ?? process.env;
  const defaults: KlopsiConfiguration = {
    provider: "opsi",
    output: "human",
    locale: "sl-SI",
    offline: false,
    paths: { cacheDir: paths.cacheDir, downloadDir: paths.downloadDir },
    http: { timeoutMs: 30_000, maxDownloadBytes: 2 * 1024 * 1024 * 1024, retries: 2 },
    preview: { rowLimit: 20 },
    query: { rowLimit: 1_000, timeoutMs: 30_000 },
    duckdb: {
      memoryLimit: "1GB",
      threads: 4,
      cache: { enabled: true, maxBytes: "10GB", ttlDays: 30 },
    },
    terminal: { color: runtimeEnv.NO_COLOR === undefined },
    archive: {
      maxEntries: 10_000,
      maxPathBytes: 1_024,
      maxSelectedBytes: 512 * 1024 * 1024,
      maxExpandedBytes: 1024 * 1024 * 1024,
      maxCompressionRatio: 200,
    },
    xml: {
      maxDocumentBytes: 64 * 1024 * 1024,
      maxDepth: 128,
      maxAttributesPerElement: 256,
      maxValueBytes: 1024 * 1024,
      maxColumns: 1_024,
      maxRecords: 100_000,
      maxStateBytes: 64 * 1024 * 1024,
    },
  };
  const user = await readSource(paths.userFile);
  const project = await readSource(paths.projectFile);
  const env = environmentSource(runtimeEnv);
  const cli = cliSource(options.cli ?? {});

  return parseConfiguration(
    [user, project, env, cli].reduce<MutableRecord>((result, source) => merge(result, source), {
      ...defaults,
    }),
  );
}
