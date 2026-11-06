import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { recordsToRows } from "./csv.js";
import type { DataRow, ValidationIssue } from "./types.js";
import { openXlsxWorkbook, type XlsxCell, type XlsxRow, type XlsxWorkbook } from "./xlsx-reader.js";

function openBounded(path: string, sharedStringsByteLimit: number): Promise<XlsxWorkbook> {
  return openXlsxWorkbook(path, { maxSharedStringsBytes: sharedStringsByteLimit });
}

export async function listSheets(
  path: string,
  sharedStringsByteLimit: number,
): Promise<readonly string[]> {
  return (await openBounded(path, sharedStringsByteLimit)).sheetNames;
}

function cellValue(
  cell: XlsxCell | undefined,
  column: number,
  warnings: ValidationIssue[],
  row: number,
): unknown {
  if (cell === undefined) return null;
  if (cell.formula !== undefined) {
    warnings.push({
      code: "FORMULA_CELL",
      severity: "warning",
      message:
        "The workbook contains a formula cell; its formula was preserved without evaluation.",
      recommendation:
        "Review the formula in a trusted spreadsheet application if its result is needed.",
      row,
      column,
    });
    // Shared-formula followers carry no text of their own; keep the cached value.
    return cell.formula.length > 0 ? `=${cell.formula}` : cell.value;
  }
  return cell.value;
}

function rowValues(row: XlsxRow, warnings: ValidationIssue[]): unknown[] {
  return Array.from(row.cells, (cell, index) => cellValue(cell, index + 1, warnings, row.number));
}

function sheetNotFound(sheet: string): KlopsiError {
  return new KlopsiError({
    code: "SHEET_NOT_FOUND",
    message: `XLSX sheet '${sheet}' was not found.`,
    exitCode: EXIT_CODES.NOT_FOUND,
    context: { sheet },
  });
}

export async function previewXlsx(
  path: string,
  sheet: string | undefined,
  limit: number,
  sharedStringsByteLimit: number,
): Promise<{
  readonly rows: readonly DataRow[];
  readonly columns: readonly string[];
  readonly truncated: boolean;
  readonly sheet: string;
  readonly warnings: readonly ValidationIssue[];
}> {
  if (sheet === undefined || sheet.trim().length === 0) {
    const sheets = await listSheets(path, sharedStringsByteLimit);
    throw new KlopsiError({
      code: "SHEET_REQUIRED",
      message: "XLSX preview requires an explicit sheet selection.",
      exitCode: EXIT_CODES.INVALID_INPUT,
      suggestion: `Use --sheet with one of: ${sheets.join(", ")}.`,
      context: { sheets },
    });
  }
  const workbook = await openBounded(path, sharedStringsByteLimit);
  if (!workbook.sheetNames.includes(sheet)) throw sheetNotFound(sheet);
  const records: unknown[][] = [];
  const warnings: ValidationIssue[] = [];
  for await (const row of workbook.rows(sheet)) {
    records.push(rowValues(row, warnings));
    if (records.length >= limit + 2) break;
  }
  const columns = (records[0] ?? []).map((value, index) =>
    value === null || value === "" ? `column_${index + 1}` : String(value),
  );
  const data = records.slice(1);
  return {
    columns,
    rows: recordsToRows(columns, data.slice(0, limit)),
    truncated: data.length > limit,
    sheet,
    warnings,
  };
}

export async function scanXlsx(
  path: string,
  sheet: string | undefined,
  options: {
    readonly maxRecords: number;
    readonly sharedStringsByteLimit: number;
    readonly maxColumns: number;
  },
  onRow: (row: DataRow, warnings: readonly ValidationIssue[]) => void,
  onIssue: (issue: ValidationIssue) => void,
  onHeader: (columns: readonly string[], warnings: readonly ValidationIssue[]) => void,
): Promise<void> {
  if (sheet === undefined || sheet.trim().length === 0) {
    const sheets = await listSheets(path, options.sharedStringsByteLimit);
    throw new KlopsiError({
      code: "SHEET_REQUIRED",
      message: "XLSX validation requires an explicit sheet selection.",
      exitCode: EXIT_CODES.INVALID_INPUT,
      suggestion: `Use --sheet with one of: ${sheets.join(", ")}.`,
      context: { sheets },
    });
  }
  const workbook = await openBounded(path, options.sharedStringsByteLimit);
  if (!workbook.sheetNames.includes(sheet)) throw sheetNotFound(sheet);
  let columns: readonly string[] | undefined;
  for await (const row of workbook.rows(sheet)) {
    const warnings: ValidationIssue[] = [];
    const values = rowValues(row, warnings);
    if (columns === undefined) {
      if (values.length > options.maxColumns)
        throw new KlopsiError({
          code: "VALIDATION_COLUMN_LIMIT",
          message: "XLSX header exceeds the column limit.",
          exitCode: 5,
          suggestion: "Reduce worksheet columns.",
        });
      const used = new Map<string, number>();
      columns = values.map((value, index) => {
        const original = value === null || value === "" ? "" : String(value);
        if (original === "")
          onIssue({
            code: "EMPTY_HEADER",
            severity: "warning",
            message: "XLSX header is empty.",
            recommendation: "Name every column.",
            row: 1,
            column: index + 1,
          });
        const base = original || `column_${index + 1}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        if (count > 1)
          onIssue({
            code: "DUPLICATE_HEADER",
            severity: "error",
            message: `Header '${base}' is duplicated.`,
            recommendation: "Rename duplicate columns.",
            row: 1,
            column: index + 1,
            field: base,
          });
        return count === 1 ? base : `${base}_${count}`;
      });
      onHeader(columns, warnings);
    } else {
      if (values.length > columns.length)
        onIssue({
          code: "INCONSISTENT_COLUMN_COUNT",
          severity: "error",
          message: `XLSX row ${row.number} has ${values.length} columns; expected ${columns.length}.`,
          recommendation: "Match every row to the header width.",
          row: row.number,
        });
      const expanded = [...columns];
      while (expanded.length < values.length) expanded.push(`extra_column_${expanded.length + 1}`);
      if (expanded.length > options.maxColumns)
        throw new KlopsiError({
          code: "VALIDATION_COLUMN_LIMIT",
          message: "XLSX row exceeds the column limit.",
          exitCode: 5,
          suggestion: "Reduce worksheet columns.",
        });
      onRow(recordsToRows(expanded, [values])[0] ?? {}, warnings);
    }
  }
}
