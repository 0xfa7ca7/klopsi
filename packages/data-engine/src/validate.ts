import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse";
import { extname } from "node:path";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { detectFormat } from "./detect.js";
import { scanWithDuckDb } from "./duckdb-import.js";
import { inferredType, type DataEngine } from "./inspect.js";
import { scanNdjson } from "./json.js";
import { scanXlsx } from "./xlsx.js";
import { previewXml } from "./xml.js";
import {
  DEFAULT_PCAXIS_LIMITS,
  parsePcAxisMetadata,
  writePcAxisRowsAsNdjson,
  type PcAxisLimits,
} from "./pcaxis.js";
import type { DelimitedDialect, TextEncoding } from "./text-decoding.js";
import type {
  DataSource,
  DataValidationResult,
  PreviewOptions,
  ValidationIssue,
  ValidationSeverity,
} from "./types.js";

function issue(
  code: string,
  severity: ValidationSeverity,
  message: string,
  recommendation: string,
  location: Partial<Pick<ValidationIssue, "row" | "column" | "field" | "context">> = {},
): ValidationIssue {
  return { code, severity, message, recommendation, ...location };
}

async function validateDelimitedStream(
  path: string,
  delimiter: DelimitedDialect,
  encoding: TextEncoding,
  limits: ConstructorParameters<typeof StreamingDiagnostics>[0],
): Promise<readonly ValidationIssue[]> {
  const diagnostics = new StreamingDiagnostics(limits);
  const source = createReadStream(path);
  const decodedSource =
    encoding === "utf-16be"
      ? Readable.from(
          (async function* () {
            const decoder = new TextDecoder("utf-16be", { fatal: true });
            for await (const chunk of source)
              yield decoder.decode(Buffer.from(chunk as Uint8Array), { stream: true });
            yield decoder.decode();
          })(),
        )
      : source;
  const parser = parse({
    bom: true,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: limits.maxRecordBytes,
    encoding: encoding === "utf-16le" ? "utf16le" : "utf8",
  });
  decodedSource.pipe(parser);
  let headers: readonly string[] | undefined;
  let rowNumber = 0;
  try {
    for await (const raw of parser) {
      const record = (raw as unknown[]).map(String);
      rowNumber += 1;
      if (headers === undefined) {
        headers = record;
        const headerIssues: ValidationIssue[] = [];
        const first = new Map<string, number>();
        record.forEach((field, index) => {
          const prior = first.get(field);
          if (prior === undefined) first.set(field, index);
          else
            headerIssues.push(
              issue(
                "DUPLICATE_HEADER",
                "error",
                `Header '${field}' is duplicated.`,
                "Rename columns so every header is unique.",
                {
                  row: 1,
                  column: index + 1,
                  field,
                  context: { firstColumn: prior + 1 },
                },
              ),
            );
        });
        diagnostics.chargeHeader(record, headerIssues);
        continue;
      }
      const warnings: ValidationIssue[] = [];
      if (record.length !== headers.length)
        warnings.push(
          issue(
            "INCONSISTENT_COLUMN_COUNT",
            "error",
            `Row ${rowNumber} has ${record.length} columns; expected ${headers.length}.`,
            "Add or remove fields so the row matches the header width.",
            { row: rowNumber, context: { expected: headers.length, actual: record.length } },
          ),
        );
      diagnostics.add(
        Object.fromEntries(headers.map((header, index) => [header, record[index] ?? null])),
        warnings,
        false,
      );
    }
    return diagnostics.finish();
  } finally {
    source.destroy();
    if (decodedSource !== source) decodedSource.destroy();
    parser.destroy();
  }
}

async function validUtf8(path: string): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of createReadStream(path))
      decoder.decode(chunk as Uint8Array, { stream: true });
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

function grouped(
  issues: readonly ValidationIssue[],
  severity: ValidationSeverity,
): readonly ValidationIssue[] {
  return issues.filter((candidate) => candidate.severity === severity);
}

function complete(
  issues: readonly ValidationIssue[],
  format?: DataValidationResult["format"],
  schema?: DataValidationResult["schema"],
): DataValidationResult {
  const errors = grouped(issues, "error");
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings: grouped(issues, "warning"),
    recommendations: grouped(issues, "recommendation"),
    ...(format === undefined ? {} : { format }),
    ...(schema === undefined ? {} : { schema }),
  };
}

export function analyzeRows(
  headers: readonly string[],
  records: readonly (readonly unknown[])[],
  widths: readonly number[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstHeader = new Map<string, number>();
  headers.forEach((header, index) => {
    const prior = firstHeader.get(header);
    if (prior === undefined) firstHeader.set(header, index);
    else
      issues.push(
        issue(
          "DUPLICATE_HEADER",
          "error",
          `Header '${header}' is duplicated.`,
          "Rename columns so every header is unique.",
          { row: 1, column: index + 1, field: header, context: { firstColumn: prior + 1 } },
        ),
      );
  });
  widths.forEach((width, index) => {
    if (width !== headers.length)
      issues.push(
        issue(
          "INCONSISTENT_COLUMN_COUNT",
          "error",
          `Row ${index + 2} has ${width} columns; expected ${headers.length}.`,
          "Add or remove fields so the row matches the header width.",
          { row: index + 2, context: { expected: headers.length, actual: width } },
        ),
      );
  });
  const seen = new Map<string, number>();
  records.forEach((record, index) => {
    const key = JSON.stringify(record);
    const prior = seen.get(key);
    if (prior === undefined) seen.set(key, index + 2);
    else
      issues.push(
        issue(
          "DUPLICATE_ROW",
          "warning",
          `Row ${index + 2} duplicates row ${prior}.`,
          "Confirm the duplicate is intentional or remove it.",
          { row: index + 2, context: { duplicateOf: prior } },
        ),
      );
    record.forEach((value, column) => {
      if (typeof value === "string" && /^[=+\-@]/u.test(value))
        issues.push(
          issue(
            "FORMULA_LIKE_VALUE",
            "warning",
            "A value begins with a spreadsheet formula trigger.",
            "Treat the value as untrusted text when exporting to spreadsheet formats.",
            {
              row: index + 2,
              column: column + 1,
              ...(headers[column] === undefined ? {} : { field: headers[column] }),
            },
          ),
        );
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        inferredType(value) === "string"
      )
        issues.push(
          issue(
            "INVALID_DATE",
            "warning",
            `Value '${value}' looks like an invalid calendar date.`,
            "Use a real date in YYYY-MM-DD form or store it as explicitly documented text.",
            {
              row: index + 2,
              column: column + 1,
              ...(headers[column] === undefined ? {} : { field: headers[column] }),
            },
          ),
        );
    });
  });
  headers.forEach((header, column) => {
    const values = records.map((record) => record[column] ?? "");
    const nonNull = values.filter((value) => inferredType(value) !== "null");
    const types = new Set(nonNull.map(inferredType));
    if (types.size > 1 && !(types.size === 2 && types.has("integer") && types.has("double")))
      issues.push(
        issue(
          "MIXED_TYPES",
          "warning",
          `Column '${header}' contains mixed value types.`,
          "Normalize the column to one documented type.",
          { field: header, column: column + 1, context: { types: [...types] } },
        ),
      );
    if (values.length > 0 && nonNull.length / values.length <= 0.5)
      issues.push(
        issue(
          "NULL_HEAVY_COLUMN",
          "warning",
          `Column '${header}' is at least 50% empty.`,
          "Confirm the field is useful and document why values are missing.",
          {
            field: header,
            column: column + 1,
            context: { nullCount: values.length - nonNull.length, rowCount: values.length },
          },
        ),
      );
  });
  return issues;
}

class StreamingDiagnostics {
  readonly issues: ValidationIssue[] = [];
  private readonly seen = new Map<string, number>();
  private readonly fields = new Map<string, { nonNull: number; types: Set<string> }>();
  private readonly grouped = new Map<string, { issue: ValidationIssue; count: number }>();
  private rows = 0;
  private totalBytes = 0;
  private stateBytes = 0;
  constructor(
    private readonly limits: {
      readonly maxRecords: number;
      readonly maxRecordBytes: number;
      readonly maxTotalBytes: number;
      readonly maxColumns: number;
      readonly maxStateBytes: number;
      readonly maxIssueGroups: number;
    },
  ) {}
  private retain(bytes: number): void {
    this.stateBytes += bytes;
    if (this.stateBytes > this.limits.maxStateBytes)
      throw new KlopsiError({
        code: "VALIDATION_STATE_LIMIT",
        message: "Validation retained-state limit exceeded.",
        exitCode: 5,
        suggestion: "Split the input into smaller files.",
      });
  }
  addIssue(candidate: ValidationIssue, key = `${candidate.code}:${candidate.field ?? ""}`): void {
    const current = this.grouped.get(key);
    if (current !== undefined) {
      current.count += 1;
      return;
    }
    if (this.grouped.size >= this.limits.maxIssueGroups)
      throw new KlopsiError({
        code: "VALIDATION_ISSUE_LIMIT",
        message: "Validation issue-group limit exceeded.",
        exitCode: 5,
        suggestion: "Split the input into smaller files.",
      });
    this.retain(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(candidate)));
    this.grouped.set(key, { issue: candidate, count: 1 });
  }
  chargeHeader(columns: readonly string[], warnings: readonly ValidationIssue[]): void {
    if (columns.length > this.limits.maxColumns)
      throw new KlopsiError({
        code: "VALIDATION_COLUMN_LIMIT",
        message: "Validation header exceeds the column limit.",
        exitCode: 5,
        suggestion: "Reduce the number of columns.",
      });
    const serialized = JSON.stringify(columns);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.limits.maxRecordBytes)
      throw new KlopsiError({
        code: "VALIDATION_RECORD_TOO_LARGE",
        message: "Validation header exceeds the record byte limit.",
        exitCode: 5,
        suggestion: "Shorten header values.",
      });
    this.totalBytes += bytes;
    if (this.totalBytes > this.limits.maxTotalBytes)
      throw new KlopsiError({
        code: "VALIDATION_TOTAL_BYTES_LIMIT",
        message: "Validation total byte limit exceeded.",
        exitCode: 5,
        suggestion: "Shorten header values.",
      });
    this.retain(bytes);
    for (const warning of warnings) this.addIssue(warning);
  }
  add(
    row: Readonly<Record<string, unknown>>,
    warnings: readonly ValidationIssue[] = [],
    aggregateCellIssues = true,
  ): void {
    const columns = Object.keys(row);
    if (columns.length > this.limits.maxColumns)
      throw new KlopsiError({
        code: "VALIDATION_COLUMN_LIMIT",
        message: "Validation column limit exceeded.",
        exitCode: 5,
        suggestion: "Reduce the number of columns.",
        context: { limit: this.limits.maxColumns },
      });
    if (this.rows >= this.limits.maxRecords)
      throw new KlopsiError({
        code: "VALIDATION_RECORD_LIMIT",
        message: "Validation record limit exceeded.",
        exitCode: 5,
        suggestion: "Split the input into smaller files.",
        context: { limit: this.limits.maxRecords },
      });
    const serialized = JSON.stringify(row);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.limits.maxRecordBytes)
      throw new KlopsiError({
        code: "VALIDATION_RECORD_TOO_LARGE",
        message: "A validation record exceeds the byte limit.",
        exitCode: 5,
        suggestion: "Reduce the record size.",
        context: { limit: this.limits.maxRecordBytes },
      });
    this.totalBytes += bytes;
    if (this.totalBytes > this.limits.maxTotalBytes)
      throw new KlopsiError({
        code: "VALIDATION_TOTAL_BYTES_LIMIT",
        message: "Validation total byte limit exceeded.",
        exitCode: 5,
        suggestion: "Split the input into smaller files.",
        context: { limit: this.limits.maxTotalBytes },
      });
    this.rows += 1;
    const fingerprint = createHash("sha256").update(serialized).digest("base64url");
    const prior = this.seen.get(fingerprint);
    if (prior === undefined) {
      this.retain(52);
      this.seen.set(fingerprint, this.rows);
    } else
      this.addIssue(
        issue(
          "DUPLICATE_ROW",
          "warning",
          `Row ${this.rows + 1} duplicates row ${prior + 1}.`,
          "Confirm the duplicate is intentional or remove it.",
          { row: this.rows + 1 },
        ),
        `DUPLICATE_ROW:${fingerprint}`,
      );
    for (const warning of warnings) this.addIssue(warning);
    for (const [field, value] of Object.entries(row)) {
      let state = this.fields.get(field);
      if (state === undefined) {
        this.retain(Buffer.byteLength(field) + 24);
        state = { nonNull: 0, types: new Set<string>() };
        this.fields.set(field, state);
      }
      const type = inferredType(value);
      if (type !== "null") {
        state.nonNull += 1;
        state.types.add(type);
      }
      if (typeof value === "string" && /^[=+\-@]/u.test(value))
        this.addIssue(
          issue(
            "FORMULA_LIKE_VALUE",
            "warning",
            "A value begins with a spreadsheet formula trigger.",
            "Treat the value as untrusted text.",
            { row: this.rows + 1, field },
          ),
          aggregateCellIssues ? undefined : `FORMULA_LIKE_VALUE:${field}:${this.rows}`,
        );
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && type === "string")
        this.addIssue(
          issue(
            "INVALID_DATE",
            "warning",
            `Value '${value}' looks like an invalid calendar date.`,
            "Use a real YYYY-MM-DD date.",
            { row: this.rows + 1, field },
          ),
          aggregateCellIssues ? undefined : `INVALID_DATE:${field}:${this.rows}`,
        );
    }
  }
  finish(): readonly ValidationIssue[] {
    for (const [field, state] of this.fields) {
      if (
        state.types.size > 1 &&
        !(state.types.size === 2 && state.types.has("integer") && state.types.has("double"))
      )
        this.addIssue(
          issue(
            "MIXED_TYPES",
            "warning",
            `Column '${field}' contains mixed value types.`,
            "Normalize the column to one type.",
            { field },
          ),
        );
      if (this.rows > 0 && state.nonNull / this.rows <= 0.5)
        this.addIssue(
          issue(
            "NULL_HEAVY_COLUMN",
            "warning",
            `Column '${field}' is at least 50% empty.`,
            "Document missing values.",
            { field },
          ),
        );
    }
    for (const { issue: groupedIssue, count } of this.grouped.values())
      this.issues.push({
        ...groupedIssue,
        context: { ...groupedIssue.context, occurrenceCount: count },
      });
    return this.issues;
  }
}

function validationRecordLimit(limit: number): KlopsiError {
  return new KlopsiError({
    code: "VALIDATION_RECORD_LIMIT",
    message: "Validation record limit exceeded.",
    exitCode: 5,
    suggestion: "Split the input into smaller files.",
    context: { limit },
  });
}

async function validatePcAxisStream(
  path: string,
  limits: ConstructorParameters<typeof StreamingDiagnostics>[0] & {
    readonly pcAxisLimits?: PcAxisLimits;
  },
): Promise<readonly ValidationIssue[]> {
  const pcAxisLimits = limits.pcAxisLimits ?? DEFAULT_PCAXIS_LIMITS;
  const metadata = await parsePcAxisMetadata(path, pcAxisLimits);
  if (metadata.expectedCellCount > limits.maxRecords)
    throw validationRecordLimit(limits.maxRecords);

  const directory = await mkdtemp(join(tmpdir(), "klopsi-pcaxis-validation-"));
  const rowsPath = join(directory, "rows.ndjson");
  try {
    const normalized = await writePcAxisRowsAsNdjson(
      path,
      rowsPath,
      {},
      {
        ...pcAxisLimits,
        maxEmittedRecords: Math.min(pcAxisLimits.maxEmittedRecords, limits.maxRecords),
      },
    );
    const diagnostics = new StreamingDiagnostics(limits);
    await scanNdjson(
      rowsPath,
      { maxRecords: limits.maxRecords, maxRecordBytes: limits.maxRecordBytes },
      (row) => diagnostics.add(row),
    );
    return [...normalized.warnings, ...diagnostics.finish()];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function validateData(
  engine: DataEngine,
  source: DataSource,
  options: PreviewOptions,
  limits: {
    readonly maxRecords: number;
    readonly maxRecordBytes: number;
    readonly xlsxSharedStringsByteLimit: number;
    readonly maxTotalBytes: number;
    readonly maxColumns: number;
    readonly maxStateBytes: number;
    readonly maxIssueGroups: number;
    readonly xmlLimits?: import("./xml.js").XmlLimits;
    readonly pcAxisLimits?: PcAxisLimits;
  },
): Promise<DataValidationResult> {
  const detection = await detectFormat(source);
  const issues: ValidationIssue[] = [];
  if (detection.format === "zip" || detection.format === "unknown") {
    await engine.preview(source, { limit: 1 });
  }
  if (
    ["csv", "tsv", "json", "ndjson"].includes(detection.format) &&
    detection.encoding !== "utf-16le" &&
    detection.encoding !== "utf-16be" &&
    !(await validUtf8(detection.path))
  )
    return complete(
      [
        issue(
          "INVALID_ENCODING",
          "error",
          "The file is not valid UTF-8.",
          "Convert the source to UTF-8 without replacing invalid bytes.",
        ),
      ],
      detection.format,
    );

  const extension = extname(detection.path).toLowerCase();
  if (
    (extension === ".csv" && detection.format === "tsv") ||
    (extension === ".tsv" && detection.format === "csv")
  )
    issues.push(
      issue(
        "DELIMITER_MISMATCH",
        "warning",
        `The file extension disagrees with the detected ${detection.format.toUpperCase()} delimiter.`,
        "Rename the file or correct its delimiter.",
      ),
    );

  if (detection.format === "csv" || detection.format === "tsv") {
    const delimiter = detection.delimiter ?? (detection.format === "csv" ? "," : "\t");
    const encoding = detection.encoding;
    if (encoding === "windows-1250")
      throw new KlopsiError({
        code: "UNSUPPORTED_FORMAT",
        message: "Windows-1250 text requires a PC-Axis reader.",
        exitCode: EXIT_CODES.UNSUPPORTED,
      });
    try {
      issues.push(
        ...(await validateDelimitedStream(detection.path, delimiter, encoding ?? "utf-8", limits)),
      );
    } catch (error) {
      if (error instanceof KlopsiError) throw error;
      issues.push(
        issue(
          "MALFORMED_DELIMITED_DATA",
          "error",
          "The delimited file cannot be parsed.",
          "Repair quoting, escaping, and record boundaries.",
          { context: { detail: error instanceof Error ? error.message : String(error) } },
        ),
      );
    }
  }

  if (
    ["json", "ndjson", "xlsx", "parquet", "xml", "pcaxis"].includes(detection.format) &&
    !issues.some((candidate) => candidate.severity === "error")
  ) {
    try {
      const diagnostics = new StreamingDiagnostics(limits);
      if (detection.format === "pcaxis")
        issues.push(...(await validatePcAxisStream(detection.path, limits)));
      else if (detection.format === "ndjson")
        await scanNdjson(
          detection.path,
          { maxRecords: limits.maxRecords, maxRecordBytes: limits.maxRecordBytes },
          (row) => diagnostics.add(row),
        );
      else if (detection.format === "xlsx")
        await scanXlsx(
          detection.path,
          options.sheet,
          {
            maxRecords: limits.maxRecords,
            sharedStringsByteLimit: limits.xlsxSharedStringsByteLimit,
            maxColumns: limits.maxColumns,
          },
          (row, warnings) => diagnostics.add(row, warnings),
          (headerIssue) => diagnostics.addIssue(headerIssue),
          (columns, warnings) => diagnostics.chargeHeader(columns, warnings),
        );
      else if (detection.format === "xml") {
        const preview = await previewXml(
          detection.path,
          {
            limit: limits.maxRecords,
            ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
          },
          limits.xmlLimits,
        );
        if (preview.truncated)
          throw new KlopsiError({
            code: "VALIDATION_RECORD_LIMIT",
            message: "Validation record limit exceeded.",
            exitCode: 5,
            context: { limit: limits.maxRecords },
          });
        for (const row of preview.rows) diagnostics.add(row);
      } else
        await scanWithDuckDb(detection.path, detection.format as "json" | "parquet", (row) =>
          diagnostics.add(row),
        );
      issues.push(...diagnostics.finish());
    } catch (error) {
      if (detection.format === "pcaxis" && error instanceof KlopsiError) throw error;
      if (
        error instanceof KlopsiError &&
        [
          "SHEET_REQUIRED",
          "SHEET_NOT_FOUND",
          "XLSX_SHARED_STRINGS_TOO_LARGE",
          "XLSX_LIMIT_EXCEEDED",
          "DOWNLOAD_ONLY_FORMAT",
          "UNSUPPORTED_FORMAT",
          "VALIDATION_RECORD_LIMIT",
          "VALIDATION_RECORD_TOO_LARGE",
          "VALIDATION_TOTAL_BYTES_LIMIT",
          "VALIDATION_COLUMN_LIMIT",
          "VALIDATION_STATE_LIMIT",
          "VALIDATION_ISSUE_LIMIT",
        ].includes(error.code)
      )
        throw error;
      issues.push(
        issue(
          "PARSE_ERROR",
          "error",
          "The structured data cannot be parsed.",
          "Repair the malformed record or replace the file.",
          { context: { detail: error instanceof Error ? error.message : String(error) } },
        ),
      );
    }
  }
  let schema;
  try {
    schema = await engine.inferSchema(source, options);
  } catch (error) {
    if (detection.format === "pcaxis" && error instanceof KlopsiError) throw error;
    if (
      error instanceof KlopsiError &&
      [
        "SHEET_REQUIRED",
        "SHEET_NOT_FOUND",
        "XLSX_SHARED_STRINGS_TOO_LARGE",
        "XLSX_LIMIT_EXCEEDED",
        "DOWNLOAD_ONLY_FORMAT",
        "UNSUPPORTED_FORMAT",
      ].includes(error.code)
    )
      throw error;
    if (issues.some((candidate) => candidate.severity === "error"))
      return complete(issues, detection.format);
    issues.push(
      issue(
        "PARSE_ERROR",
        "error",
        "The data could not be parsed.",
        "Repair the file and retry validation.",
        { context: { detail: error instanceof Error ? error.message : String(error) } },
      ),
    );
  }
  return complete(issues, detection.format, schema);
}
