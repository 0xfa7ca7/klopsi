import { duckDbMemoryLimitBytes, EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { z } from "zod";
import { parseStorageBytes } from "./byte-size.js";

export const outputFormatSchema = z.enum(["human", "json", "ndjson", "csv", "tsv"]);

const pathsSchema = z.strictObject({
  cacheDir: z.string().min(1),
  downloadDir: z.string().min(1),
});

const httpSchema = z.strictObject({
  timeoutMs: z.number().int().positive(),
  maxDownloadBytes: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});

const previewSchema = z.strictObject({
  rowLimit: z.number().int().positive(),
});

const querySchema = z.strictObject({
  rowLimit: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

const duckdbCacheSchema = z.strictObject({
  enabled: z.boolean(),
  maxBytes: z.string().refine((value) => parseStorageBytes(value) !== undefined, {
    message: "must be a supported nonnegative byte size",
  }),
  ttlDays: z.number().int().positive(),
});

const duckdbSchema = z.strictObject({
  memoryLimit: z.string().refine((value) => duckDbMemoryLimitBytes(value) !== undefined, {
    message: "must be a supported positive byte size no larger than 1GB",
  }),
  threads: z.number().int().positive().max(4),
  cache: duckdbCacheSchema,
});

const duckdbSourceSchema = duckdbSchema.partial().extend({
  cache: duckdbCacheSchema.partial().optional(),
});

const terminalSchema = z.strictObject({
  color: z.boolean(),
});

const archiveSchema = z.strictObject({
  maxEntries: z.number().int().positive(),
  maxPathBytes: z.number().int().positive(),
  maxSelectedBytes: z.number().int().positive(),
  maxExpandedBytes: z.number().int().positive(),
  maxCompressionRatio: z.number().positive(),
});

const xmlSchema = z.strictObject({
  maxDocumentBytes: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxAttributesPerElement: z.number().int().positive(),
  maxValueBytes: z.number().int().positive(),
  maxColumns: z.number().int().positive(),
  maxRecords: z.number().int().positive(),
  maxStateBytes: z.number().int().positive(),
});

export const configurationSchema = z.strictObject({
  provider: z.string().trim().min(1),
  output: outputFormatSchema,
  locale: z.string().trim().min(1),
  offline: z.boolean(),
  paths: pathsSchema,
  http: httpSchema,
  preview: previewSchema,
  query: querySchema,
  duckdb: duckdbSchema,
  terminal: terminalSchema,
  archive: archiveSchema,
  xml: xmlSchema,
  apiKey: z.string().min(1).optional(),
});

export const configurationSourceSchema = z.strictObject({
  provider: z.string().trim().min(1).optional(),
  output: outputFormatSchema.optional(),
  locale: z.string().trim().min(1).optional(),
  offline: z.boolean().optional(),
  paths: pathsSchema.partial().optional(),
  http: httpSchema.partial().optional(),
  preview: previewSchema.partial().optional(),
  query: querySchema.partial().optional(),
  duckdb: duckdbSourceSchema.optional(),
  terminal: terminalSchema.partial().optional(),
  archive: archiveSchema.partial().optional(),
  xml: xmlSchema.partial().optional(),
});

export type OutputFormat = z.infer<typeof outputFormatSchema>;
export type KlopsiConfiguration = z.infer<typeof configurationSchema>;
export type ConfigurationSource = z.infer<typeof configurationSourceSchema>;

export function invalidConfiguration(cause: unknown): KlopsiError {
  const detail =
    cause instanceof z.ZodError
      ? cause.issues
          .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
          .join("; ")
      : cause instanceof Error
        ? cause.message
        : "The configuration could not be read.";

  return new KlopsiError({
    code: "INVALID_CONFIGURATION",
    message: `Invalid configuration: ${detail}`,
    exitCode: EXIT_CODES.INVALID_INPUT,
    suggestion: "Correct the configuration value or remove the invalid setting.",
    cause,
  });
}

export function parseConfigurationSource(value: unknown): ConfigurationSource {
  const parsed = configurationSourceSchema.safeParse(value);
  if (!parsed.success) throw invalidConfiguration(parsed.error);
  return parsed.data;
}

export function parseConfiguration(value: unknown): KlopsiConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw invalidConfiguration(parsed.error);
  return parsed.data;
}
