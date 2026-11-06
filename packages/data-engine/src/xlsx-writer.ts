// Streaming XLSX writer. Emits a minimal, deterministic SpreadsheetML package:
// inline strings (no shared-string table to hold in memory), numbers, booleans,
// and dates with a single date style. It never writes formulas, so string
// values are always stored as literal text.
import { rm } from "node:fs/promises";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "./xlsx-reader.js";
import { xlsxLimit, ZipFileWriter } from "./xlsx-zip.js";

export type XlsxWriteValue = string | number | boolean | Date | null | undefined;

export interface XlsxSheetSource {
  readonly name: string;
  readonly rows: AsyncIterable<readonly XlsxWriteValue[]> | Iterable<readonly XlsxWriteValue[]>;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const DATE_STYLE = 1;
const CHUNK_CHARS = 64 * 1024;
const DAY_MS = 86_400_000;
const UNIX_EPOCH_SERIAL = 25_569;
// 10000-01-01 is the first date Excel cannot represent.
const MAX_DATE_SERIAL = 2_958_466;

function invalidSheetName(name: string, reason: string): KlopsiError {
  return new KlopsiError({
    code: "INVALID_XLSX_SHEET_NAME",
    message: `XLSX sheet name '${name}' is invalid: ${reason}.`,
    exitCode: EXIT_CODES.INVALID_INPUT,
    context: { sheet: name },
  });
}

function validateSheetNames(sheets: readonly XlsxSheetSource[]): void {
  if (sheets.length === 0)
    throw new KlopsiError({
      code: "INVALID_XLSX_SHEET_NAME",
      message: "An XLSX workbook needs at least one sheet.",
      exitCode: EXIT_CODES.INVALID_INPUT,
    });
  const seen = new Set<string>();
  for (const { name } of sheets) {
    if (name.length === 0 || name.length > 31) throw invalidSheetName(name, "use 1-31 characters");
    // eslint-disable-next-line no-control-regex -- control characters are rejected here
    if (/[\u0000-\u001f[\]:*?/\\]/u.test(name))
      throw invalidSheetName(name, "remove control characters and []:*?/\\");
    if (name.startsWith("'") || name.endsWith("'"))
      throw invalidSheetName(name, "do not start or end with an apostrophe");
    const folded = name.toLowerCase();
    if (folded === "history") throw invalidSheetName(name, "the name is reserved");
    if (seen.has(folded)) throw invalidSheetName(name, "sheet names must be unique");
    seen.add(folded);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', "&quot;");
}

/**
 * Encodes text for a SpreadsheetML <t> element: literal `_xHHHH_` sequences are
 * protected, characters XML 1.0 cannot carry use the OOXML `_xHHHH_` escape,
 * CR becomes a character reference, and lone surrogates become U+FFFD.
 */
export function encodeCellText(value: string): string {
  const text = value
    .replace(/_x([0-9A-Fa-f]{4})_/gu, "_x005F_x$1_")
    .replace(
      // eslint-disable-next-line no-control-regex -- controls are deliberately escaped here
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu,
      (character) => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
    )
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, "\ufffd");
  // A character reference keeps CR intact; XML parsers normalize a literal CR to LF.
  return escapeXml(text).replaceAll("\r", "&#13;");
}

const columnNames: string[] = [];
function columnName(index: number): string {
  let name = columnNames[index];
  if (name === undefined) {
    name = "";
    for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26))
      name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
    columnNames[index] = name;
  }
  return name;
}

function dateSerial(value: Date): number | undefined {
  const time = value.getTime();
  if (Number.isNaN(time)) return undefined;
  const real = time / DAY_MS + UNIX_EPOCH_SERIAL;
  // Mirror Excel's phantom 1900-02-29: serials before March 1900 shift by one.
  const serial = real < 61 ? real - 1 : real;
  return serial >= 1 && serial < MAX_DATE_SERIAL ? serial : undefined;
}

function inlineString(reference: string, text: string): string {
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${encodeCellText(text)}</t></is></c>`;
}

function cellXml(reference: string, value: XlsxWriteValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return inlineString(reference, value);
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === "number")
    return Number.isFinite(value)
      ? `<c r="${reference}"><v>${Object.is(value, -0) ? 0 : value}</v></c>`
      : inlineString(reference, String(value));
  const serial = dateSerial(value);
  if (serial === undefined)
    return inlineString(
      reference,
      Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(),
    );
  return `<c r="${reference}" s="${DATE_STYLE}"><v>${serial}</v></c>`;
}

async function* worksheetXml(source: XlsxSheetSource["rows"]): AsyncGenerator<string> {
  let buffer = `${XML_DECLARATION}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>`;
  let rowNumber = 0;
  for await (const values of source) {
    rowNumber += 1;
    if (rowNumber > XLSX_MAX_ROWS)
      throw xlsxLimit("The XLSX output exceeds the spreadsheet row limit.", {
        limit: XLSX_MAX_ROWS,
      });
    if (values.length > XLSX_MAX_COLUMNS)
      throw xlsxLimit("The XLSX output exceeds the spreadsheet column limit.", {
        columns: values.length,
        limit: XLSX_MAX_COLUMNS,
      });
    let row = `<row r="${rowNumber}">`;
    values.forEach((value, index) => {
      row += cellXml(`${columnName(index)}${rowNumber}`, value);
    });
    buffer += `${row}</row>`;
    if (buffer.length >= CHUNK_CHARS) {
      yield buffer;
      buffer = "";
    }
  }
  yield `${buffer}</sheetData></worksheet>`;
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function workbookXml(sheets: readonly XlsxSheetSource[]): string {
  const entries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return `${XML_DECLARATION}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${entries}</sheets></workbook>`;
}

function workbookRels(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL}">${sheets}<Relationship Id="rId${sheetCount + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`;
}

const STYLES = `${XML_DECLARATION}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * Writes an XLSX workbook to a new file (it must not exist). Rows are streamed,
 * so memory use is bounded by one 64 KiB XML chunk rather than the sheet size.
 */
export async function writeXlsx(path: string, sheets: readonly XlsxSheetSource[]): Promise<void> {
  validateSheetNames(sheets);
  const zip = await ZipFileWriter.create(path);
  try {
    await zip.add("[Content_Types].xml", [contentTypes(sheets.length)]);
    await zip.add("_rels/.rels", [ROOT_RELS]);
    await zip.add("xl/workbook.xml", [workbookXml(sheets)]);
    await zip.add("xl/_rels/workbook.xml.rels", [workbookRels(sheets.length)]);
    await zip.add("xl/styles.xml", [STYLES]);
    for (const [index, sheet] of sheets.entries())
      await zip.add(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows));
    await zip.finish();
  } catch (error) {
    await zip.close();
    await rm(path, { force: true });
    throw error;
  }
}
