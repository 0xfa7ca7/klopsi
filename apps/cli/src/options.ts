import type { CliConfigurationOptions, OutputFormat } from "@klopsi/config";
import type { Command } from "commander";
import { registerGlobalOptions } from "./command-manifest.js";

type CliOutputFormat = "table" | "json" | "ndjson" | "csv" | "tsv";
const STRUCTURED_FORMATS = ["json", "ndjson", "csv", "tsv"] as const;

export interface GlobalOptions {
  readonly provider?: string;
  readonly outputFormat?: CliOutputFormat;
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
  readonly quiet?: boolean;
  readonly debug?: boolean;
  readonly json?: boolean;
  readonly ndjson?: boolean;
  readonly csv?: boolean;
  readonly tsv?: boolean;
  readonly fields?: readonly string[];
}

export function selectedFields(argv: readonly string[]): readonly string[] | undefined {
  const fields: string[] = [];
  for (const [index, token] of argv.entries()) {
    const value = token.startsWith("--fields=")
      ? token.slice("--fields=".length)
      : token === "--fields"
        ? argv[index + 1]
        : undefined;
    if (value === undefined) continue;
    for (const field of value.split(",").map((candidate) => candidate.trim())) {
      if (field.length > 0 && !fields.includes(field)) fields.push(field);
    }
  }
  return fields.length === 0 ? undefined : fields;
}

export function addGlobalOptions(program: Command): Command {
  registerGlobalOptions(program);
  return program;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (const [index, token] of argv.entries()) {
    if (token.startsWith(equalsPrefix)) return token.slice(equalsPrefix.length);
    if (token === name) {
      const next = argv[index + 1];
      return next !== undefined && !next.startsWith("-") ? next : undefined;
    }
  }
  return undefined;
}

function positiveInteger(argv: readonly string[], name: string): number | undefined {
  const value = optionValue(argv, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(argv: readonly string[], name: string): number | undefined {
  const value = optionValue(argv, name);
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function requestedOutputFormat(argv: readonly string[]): OutputFormat | undefined {
  for (const format of STRUCTURED_FORMATS) {
    if (argv.includes(`--${format}`)) return format;
  }
  const output = optionValue(argv, "--output-format");
  if (output === "table") return "human";
  return STRUCTURED_FORMATS.includes(output as (typeof STRUCTURED_FORMATS)[number])
    ? (output as OutputFormat)
    : undefined;
}

export function cliConfigurationFromArgv(argv: readonly string[]): CliConfigurationOptions {
  const provider = optionValue(argv, "--provider");
  const output = requestedOutputFormat(argv);
  const cacheDir = optionValue(argv, "--cache-dir");
  const downloadDir = optionValue(argv, "--download-dir");
  const httpTimeoutMs = positiveInteger(argv, "--http-timeout-ms");
  const httpRetries = nonnegativeInteger(argv, "--http-retries");
  const maxDownloadBytes = positiveInteger(argv, "--max-download-bytes");
  const previewRowLimit = positiveInteger(argv, "--preview-row-limit");
  const queryRowLimit = positiveInteger(argv, "--query-row-limit");
  const queryTimeoutMs = positiveInteger(argv, "--query-timeout-ms");
  const duckdbMemoryLimit = optionValue(argv, "--duckdb-memory-limit");
  const duckdbThreads = positiveInteger(argv, "--duckdb-threads");
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(output === undefined ? {} : { output }),
    ...(argv.includes("--offline") ? { offline: true } : {}),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    ...(downloadDir === undefined ? {} : { downloadDir }),
    ...(httpTimeoutMs === undefined ? {} : { httpTimeoutMs }),
    ...(httpRetries === undefined ? {} : { httpRetries }),
    ...(maxDownloadBytes === undefined ? {} : { maxDownloadBytes }),
    ...(previewRowLimit === undefined ? {} : { previewRowLimit }),
    ...(queryRowLimit === undefined ? {} : { queryRowLimit }),
    ...(queryTimeoutMs === undefined ? {} : { queryTimeoutMs }),
    ...(duckdbMemoryLimit === undefined ? {} : { duckdbMemoryLimit }),
    ...(duckdbThreads === undefined ? {} : { duckdbThreads }),
    ...(argv.includes("--no-color") ? { color: false } : {}),
  };
}
