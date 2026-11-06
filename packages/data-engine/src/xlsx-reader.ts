// Bounded, streaming XLSX (SpreadsheetML) reader. It understands the subset of
// OOXML needed for tabular data: workbook/sheet relationships, shared and
// inline strings, numbers, booleans, errors, formulas (never evaluated), and
// date number formats in the 1900 and 1904 date systems.
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import { SaxesParser } from "saxes";
import {
  entryChunks,
  invalidXlsx,
  openZipPackage,
  xlsxLimit,
  type PackageEntry,
  type ZipPackage,
} from "./xlsx-zip.js";

export interface XlsxReadLimits {
  /** Maximum number of ZIP entries in the package. */
  readonly maxEntries: number;
  /** Maximum inflated bytes for workbook, relationship, and style parts. */
  readonly maxPartBytes: number;
  /** Maximum inflated bytes for the shared-string table. */
  readonly maxSharedStringsBytes: number;
  /** Maximum inflated bytes for one worksheet. */
  readonly maxWorksheetBytes: number;
  /** Maximum characters in one cell value, formula, or shared string. */
  readonly maxCellChars: number;
  /** Maximum XML element nesting depth. */
  readonly maxDepth: number;
}

export const DEFAULT_XLSX_READ_LIMITS: XlsxReadLimits = {
  maxEntries: 10_000,
  maxPartBytes: 32 * 1024 * 1024,
  maxSharedStringsBytes: 16 * 1024 * 1024,
  maxWorksheetBytes: 2 * 1024 * 1024 * 1024,
  maxCellChars: 1024 * 1024,
  maxDepth: 64,
};

export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;

export type XlsxValue = string | number | boolean | null;

export interface XlsxCell {
  readonly value: XlsxValue;
  /** Formula text without the leading '='; empty for shared-formula followers. */
  readonly formula?: string;
}

export interface XlsxRow {
  /** One-based worksheet row number. */
  readonly number: number;
  /** Cells by zero-based column index; holes are absent cells. */
  readonly cells: readonly (XlsxCell | undefined)[];
}

export interface XlsxWorkbook {
  readonly sheetNames: readonly string[];
  rows(sheet: string): AsyncGenerator<XlsxRow>;
}

const REL_SUFFIX = {
  officeDocument: "/officeDocument",
  worksheet: "/worksheet",
  sharedStrings: "/sharedStrings",
  styles: "/styles",
} as const;

/** How a number format presents a serial value. */
export type TemporalKind = "date" | "datetime" | "time" | "elapsed";

// Built-in number formats that render dates or times (ECMA-376 18.8.30 plus
// the locale-specific East Asian and Thai ids Excel maps implicitly).
const BUILT_IN_TEMPORAL_FORMATS: ReadonlyMap<number, TemporalKind> = new Map<number, TemporalKind>([
  ...[14, 15, 16, 17].map((id) => [id, "date"] as const),
  ...[18, 19, 20, 21, 45, 47].map((id) => [id, "time"] as const),
  [22, "datetime"],
  [46, "elapsed"],
  ...[27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58].map(
    (id) => [id, "date"] as const,
  ),
  [32, "time"],
  [33, "time"],
  ...[71, 72, 73, 74, 81].map((id) => [id, "date"] as const),
  ...[75, 76, 78, 80].map((id) => [id, "time"] as const),
  [77, "datetime"],
  [79, "elapsed"],
]);

interface Handlers {
  open(name: string, attributes: Readonly<Record<string, string>>): void;
  close(name: string): void;
  text(text: string): void;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function wrapError(error: unknown): KlopsiError {
  return error instanceof KlopsiError
    ? error
    : invalidXlsx("The XLSX package contains malformed XML.", error);
}

/** Streams a part through saxes, yielding whatever the handlers emit. */
/** Characters fed to saxes per write, so the run-length check stays fine-grained. */
const WRITE_SLICE_CHARS = 4_096;

/**
 * Streams a part through saxes, yielding whatever the handlers emit.
 *
 * saxes buffers a whole text node, attribute, comment, CDATA section, or
 * processing instruction before reporting it, so handler-level checks cannot
 * bound memory. Instead, every parser event resets a run counter and input is
 * fed in small slices; a run of input with no event longer than a small
 * multiple of maxCellChars fails before saxes can buffer it all.
 */
async function* parsePart<T>(
  chunks: AsyncIterable<Buffer>,
  limits: Pick<XlsxReadLimits, "maxDepth" | "maxCellChars">,
  build: (emit: (value: T) => void) => Handlers,
): AsyncGenerator<T> {
  const { maxDepth } = limits;
  const maxRun = limits.maxCellChars * 8;
  const pending: T[] = [];
  const handlers = build((value) => pending.push(value));
  const parser = new SaxesParser({ xmlns: false });
  let depth = 0;
  let sawEvent = false;
  let run = 0;
  const feed = (text: string): void => {
    for (let offset = 0; offset < text.length; offset += WRITE_SLICE_CHARS) {
      const slice = text.slice(offset, offset + WRITE_SLICE_CHARS);
      sawEvent = false;
      parser.write(slice);
      run = sawEvent ? 0 : run + slice.length;
      if (run > maxRun)
        throw xlsxLimit("An XLSX text node, attribute, or comment exceeds the bounded length.", {
          limit: maxRun,
        });
    }
  };
  // saxes keeps one handler per event, so each handler records the event itself.
  const seen = (): void => {
    sawEvent = true;
  };
  parser.on("comment", seen);
  parser.on("processinginstruction", seen);
  parser.on("doctype", () => {
    throw invalidXlsx("DTD and entity declarations are not supported in XLSX parts.");
  });
  parser.on("opentag", (tag) => {
    seen();
    depth += 1;
    if (depth > maxDepth)
      throw xlsxLimit("The XLSX part nests XML elements too deeply.", { limit: maxDepth });
    handlers.open(localName(tag.name), tag.attributes as Readonly<Record<string, string>>);
  });
  parser.on("closetag", (tag) => {
    seen();
    depth -= 1;
    handlers.close(localName(tag.name));
  });
  parser.on("text", (text) => {
    seen();
    handlers.text(text);
  });
  parser.on("cdata", (text) => {
    seen();
    handlers.text(text);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let first = true;
  try {
    for await (const chunk of chunks) {
      let text = decoder.decode(chunk, { stream: true });
      if (first && text.length > 0) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        first = false;
      }
      feed(text);
      while (pending.length > 0) yield pending.shift() as T;
    }
    feed(decoder.decode());
    parser.close();
  } catch (error) {
    throw wrapError(error);
  }
  while (pending.length > 0) yield pending.shift() as T;
}

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const value of generator) void value;
}

/** Decodes the OOXML `_xHHHH_` escape used for characters XML cannot carry. */
export function decodeOoxmlEscapes(value: string): string {
  if (!value.includes("_x")) return value;
  return value.replace(/_x([0-9A-Fa-f]{4})_/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function resolvePart(source: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Keep undecodable targets literal.
  }
  const slash = source.lastIndexOf("/");
  const raw = decoded.startsWith("/")
    ? decoded.slice(1)
    : `${slash === -1 ? "" : source.slice(0, slash + 1)}${decoded}`;
  const segments: string[] = [];
  for (const segment of raw.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0)
        throw invalidXlsx("An XLSX relationship points outside the package.");
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
}

function relsPathFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash === -1
    ? `_rels/${part}.rels`
    : `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

interface Relationship {
  readonly type: string;
  readonly target: string;
}

/**
 * Classifies a custom number format. Only the first (positive) section is
 * considered. `m`/`mm` means minutes directly after an hour token or before a
 * seconds token, and months otherwise.
 */
export function classifyNumberFormat(code: string): TemporalKind | undefined {
  const section = code
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/[_*]./gu, "")
    .split(";")[0] as string;
  let elapsed = false;
  let stripped = section.replace(/\[([^\]]*)\]/gu, (_match, inner: string) => {
    if (/^(?:h+|m+|s+)$/iu.test(inner)) elapsed = true;
    return "";
  });
  if (elapsed) return "elapsed";
  let time = false;
  stripped = stripped
    .replace(/am\/pm|a\/p/giu, () => {
      time = true;
      return "";
    })
    .replace(/general/giu, "")
    .replace(/e[+-]/giu, "");
  const tokens = (stripped.match(/[a-z]+/giu) ?? []).map((token) => token.toLowerCase());
  let date = false;
  tokens.forEach((token, index) => {
    const letter = token[0];
    if (letter === "y" || letter === "d" || letter === "b" || letter === "g") date = true;
    else if (letter === "h" || letter === "s") time = true;
    else if (letter === "m") {
      const previous = tokens[index - 1]?.[0];
      const next = tokens[index + 1]?.[0];
      if (previous === "h" || next === "s") time = true;
      else date = true;
    }
  });
  if (date && time) return "datetime";
  if (date) return "date";
  if (time) return "time";
  return undefined;
}

const DAY_MS = 86_400_000;
const UNIX_EPOCH_SERIAL = 25_569;
const DATE1904_OFFSET = 1_462;
// 10000-01-01 is the first date Excel cannot represent.
const MAX_DATE_SERIAL = 2_958_466;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Converts a serial in a date-like format to wall-clock text. Excel stores no
 * time zone, so date-times carry no offset. Time-only and elapsed formats, and
 * serials outside the representable range, keep the raw number.
 */
export function temporalValue(
  serial: number,
  kind: TemporalKind | undefined,
  date1904: boolean,
): string | number {
  if (kind === undefined || kind === "time" || kind === "elapsed") return serial;
  if (!Number.isFinite(serial) || serial < 0 || serial >= MAX_DATE_SERIAL) return serial;
  // Excel's 1900 system counts the nonexistent 1900-02-29, so serials before
  // it are one day behind the Unix-based arithmetic below.
  const adjusted = !date1904 && serial < 60 ? serial + 1 : serial;
  const days = adjusted - UNIX_EPOCH_SERIAL + (date1904 ? DATE1904_OFFSET : 0);
  const date = new Date(Math.round(days * DAY_MS));
  if (Number.isNaN(date.getTime())) return serial;
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (kind === "date") return day;
  const milliseconds = date.getUTCMilliseconds();
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day}T${clock}${milliseconds === 0 ? "" : `.${pad(milliseconds, 3)}`}`;
}

class WorkbookReader implements XlsxWorkbook {
  private sharedStrings: Promise<readonly string[]> | undefined;

  constructor(
    private readonly pkg: ZipPackage,
    private readonly limits: XlsxReadLimits,
    private readonly sheets: ReadonlyMap<string, string | undefined>,
    private readonly sharedStringsEntry: PackageEntry | undefined,
    private readonly stylesEntry: PackageEntry | undefined,
    private readonly date1904: boolean,
  ) {}

  get sheetNames(): readonly string[] {
    return [...this.sheets.keys()];
  }

  private chunks(
    entry: PackageEntry,
    limit: number,
    onLimit?: () => KlopsiError,
  ): AsyncGenerator<Buffer> {
    return entryChunks(
      this.pkg,
      entry,
      limit,
      onLimit ??
        (() =>
          xlsxLimit("The XLSX part exceeds the bounded size limit.", {
            entry: entry.name,
            bytes: entry.size,
            limit,
          })),
    );
  }

  private loadSharedStrings(): Promise<readonly string[]> {
    this.sharedStrings ??= (async () => {
      const entry = this.sharedStringsEntry;
      if (entry === undefined) return [];
      const limit = this.limits.maxSharedStringsBytes;
      const strings: string[] = [];
      const maxChars = this.limits.maxCellChars;
      await drain(
        parsePart<never>(
          this.chunks(entry, limit, () => sharedStringsTooLarge(entry.size, limit)),
          this.limits,
          () => {
            let inItem = false;
            let inText = false;
            let phonetic = 0;
            let text = "";
            return {
              open(name) {
                if (name === "si") {
                  inItem = true;
                  text = "";
                } else if (name === "rPh") phonetic += 1;
                else if (name === "t" && inItem && phonetic === 0) inText = true;
              },
              close(name) {
                if (name === "si") {
                  strings.push(decodeOoxmlEscapes(text));
                  inItem = false;
                } else if (name === "rPh") phonetic -= 1;
                else if (name === "t") inText = false;
              },
              text(value) {
                if (!inText) return;
                text += value;
                if (text.length > maxChars) throw cellTooLarge(maxChars);
              },
            };
          },
        ),
      );
      return strings;
    })();
    return this.sharedStrings;
  }

  private async loadDateStyles(): Promise<readonly (TemporalKind | undefined)[]> {
    const entry = this.stylesEntry;
    if (entry === undefined) return [];
    const custom = new Map<number, string>();
    const formats: number[] = [];
    await drain(
      parsePart<never>(this.chunks(entry, this.limits.maxPartBytes), this.limits, () => {
        let inCellXfs = false;
        let inNumFmts = false;
        return {
          open(name, attributes) {
            if (name === "numFmts") inNumFmts = true;
            else if (name === "numFmt" && inNumFmts) {
              const id = Number(attributes.numFmtId);
              if (Number.isInteger(id)) custom.set(id, attributes.formatCode ?? "");
            } else if (name === "cellXfs") inCellXfs = true;
            else if (name === "xf" && inCellXfs) formats.push(Number(attributes.numFmtId ?? 0));
          },
          close(name) {
            if (name === "cellXfs") inCellXfs = false;
            else if (name === "numFmts") inNumFmts = false;
          },
          text() {},
        };
      }),
    );
    return formats.map((id) => {
      const code = custom.get(id);
      return code === undefined ? BUILT_IN_TEMPORAL_FORMATS.get(id) : classifyNumberFormat(code);
    });
  }

  async *rows(sheet: string): AsyncGenerator<XlsxRow> {
    if (!this.sheets.has(sheet))
      throw new KlopsiError({
        code: "SHEET_NOT_FOUND",
        message: `XLSX sheet '${sheet}' was not found.`,
        exitCode: EXIT_CODES.NOT_FOUND,
        context: { sheet },
      });
    const path = this.sheets.get(sheet);
    const entry = path === undefined ? undefined : this.pkg.entry(path);
    if (entry === undefined)
      throw invalidXlsx(`The XLSX worksheet part for sheet '${sheet}' is missing.`);
    const [sharedStrings, dateStyles] = await Promise.all([
      this.loadSharedStrings(),
      this.loadDateStyles(),
    ]);
    const date1904 = this.date1904;
    const maxChars = this.limits.maxCellChars;
    yield* parsePart<XlsxRow>(
      this.chunks(entry, this.limits.maxWorksheetBytes),
      this.limits,
      (emit) => {
        let inSheetData = false;
        let row: { number: number; cells: (XlsxCell | undefined)[] } | undefined;
        let previousRow = 0;
        let previousColumn = 0;
        let cell:
          | {
              column: number;
              type: string;
              style: number;
              value?: string;
              formula?: string;
              inline?: string;
            }
          | undefined;
        let capture: "value" | "formula" | "inline" | undefined;
        let inInline = false;
        let phonetic = 0;

        const value = (): XlsxValue => {
          const current = cell as NonNullable<typeof cell>;
          const raw = current.value;
          switch (current.type) {
            case "s": {
              if (raw === undefined) return null;
              const index = Number(raw.trim());
              const text = Number.isInteger(index) ? sharedStrings[index] : undefined;
              if (text === undefined)
                throw invalidXlsx("An XLSX cell references a missing shared string.");
              return text;
            }
            case "inlineStr":
              return current.inline === undefined
                ? raw === undefined
                  ? null
                  : decodeOoxmlEscapes(raw)
                : decodeOoxmlEscapes(current.inline);
            case "str":
              return raw === undefined ? null : decodeOoxmlEscapes(raw);
            case "e":
              return raw ?? null;
            case "b": {
              if (raw === undefined || raw.trim() === "") return null;
              const flag = raw.trim().toLowerCase();
              return flag !== "0" && flag !== "false";
            }
            case "d": {
              if (raw === undefined || raw.trim() === "") return null;
              // ISO 8601 text as stored: Excel date-times are wall-clock values.
              return raw.trim();
            }
            default: {
              if (raw === undefined || raw.trim() === "") return null;
              const number = Number(raw);
              if (Number.isNaN(number)) return raw;
              return temporalValue(number, dateStyles[current.style], date1904);
            }
          }
        };

        return {
          open(name, attributes) {
            if (name === "sheetData") inSheetData = true;
            else if (!inSheetData) return;
            else if (name === "row") {
              const number =
                attributes.r === undefined ? previousRow + 1 : parseIndex(attributes.r, "row");
              if (number > XLSX_MAX_ROWS)
                throw xlsxLimit("The XLSX worksheet exceeds the spreadsheet row limit.", {
                  row: number,
                  limit: XLSX_MAX_ROWS,
                });
              row = { number, cells: [] };
              previousRow = number;
              previousColumn = 0;
            } else if (name === "c" && row !== undefined) {
              const column =
                attributes.r === undefined ? previousColumn + 1 : columnIndex(attributes.r);
              if (column > XLSX_MAX_COLUMNS)
                throw xlsxLimit("The XLSX worksheet exceeds the spreadsheet column limit.", {
                  column,
                  limit: XLSX_MAX_COLUMNS,
                });
              const style = Number(attributes.s ?? 0);
              cell = {
                column,
                type: attributes.t ?? "n",
                style: Number.isInteger(style) ? style : 0,
              };
              previousColumn = column;
            } else if (cell === undefined) return;
            else if (name === "v") {
              capture = "value";
              cell.value = "";
            } else if (name === "f") {
              capture = "formula";
              cell.formula = "";
            } else if (name === "is") {
              inInline = true;
              cell.inline = "";
            } else if (name === "rPh") phonetic += 1;
            else if (name === "t" && inInline && phonetic === 0) capture = "inline";
          },
          close(name) {
            if (name === "sheetData") inSheetData = false;
            else if (name === "row" && row !== undefined) {
              emit(row);
              row = undefined;
            } else if (name === "c" && cell !== undefined && row !== undefined) {
              const formula = cell.formula;
              row.cells[cell.column - 1] =
                formula === undefined ? { value: value() } : { value: value(), formula };
              cell = undefined;
              capture = undefined;
              inInline = false;
              phonetic = 0;
            } else if (name === "v" || name === "f" || name === "t") capture = undefined;
            else if (name === "is") inInline = false;
            else if (name === "rPh") phonetic -= 1;
          },
          text(text) {
            if (cell === undefined || capture === undefined) return;
            const key = capture;
            const next = (cell[key] ?? "") + text;
            if (next.length > maxChars) throw cellTooLarge(maxChars);
            cell[key] = next;
          },
        };
      },
    );
  }
}

function parseIndex(value: string, kind: "row"): number {
  if (!/^\d{1,10}$/u.test(value.trim()))
    throw invalidXlsx(`The XLSX worksheet contains an invalid ${kind} reference.`);
  const number = Number(value.trim());
  if (number < 1) throw invalidXlsx(`The XLSX worksheet contains an invalid ${kind} reference.`);
  return number;
}

function columnIndex(reference: string): number {
  const match = /^\$?([A-Za-z]{1,8})\$?\d*$/u.exec(reference.trim());
  if (match === null) throw invalidXlsx("The XLSX worksheet contains an invalid cell reference.");
  let column = 0;
  for (const letter of (match[1] as string).toUpperCase())
    column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

function cellTooLarge(limit: number): KlopsiError {
  return xlsxLimit("An XLSX cell exceeds the bounded text length.", { limit });
}

function sharedStringsTooLarge(bytes: number, limit: number): KlopsiError {
  return new KlopsiError({
    code: "XLSX_SHARED_STRINGS_TOO_LARGE",
    message: "The XLSX shared-string table exceeds the bounded preview limit.",
    exitCode: EXIT_CODES.UNSUPPORTED,
    suggestion: "Convert the workbook to CSV or Parquet before previewing it.",
    context: { bytes, limit },
  });
}

async function readRelationships(
  pkg: ZipPackage,
  source: string,
  limits: XlsxReadLimits,
): Promise<ReadonlyMap<string, Relationship>> {
  const entry = pkg.entry(relsPathFor(source));
  const relationships = new Map<string, Relationship>();
  if (entry === undefined) return relationships;
  await drain(
    parsePart<never>(
      entryChunks(pkg, entry, limits.maxPartBytes, () =>
        xlsxLimit("The XLSX relationship part exceeds the bounded size limit.", {
          entry: entry.name,
          limit: limits.maxPartBytes,
        }),
      ),
      limits,
      () => ({
        open(name, attributes) {
          if (name !== "Relationship") return;
          const { Id: id, Type: type, Target: target, TargetMode: mode } = attributes;
          if (id === undefined || type === undefined || target === undefined) return;
          if (mode !== undefined && mode.toLowerCase() === "external") return;
          relationships.set(id, { type, target });
        },
        close() {},
        text() {},
      }),
    ),
  );
  return relationships;
}

function findRelationship(
  relationships: ReadonlyMap<string, Relationship>,
  suffix: string,
): Relationship | undefined {
  for (const relationship of relationships.values())
    if (relationship.type.endsWith(suffix)) return relationship;
  return undefined;
}

export async function openXlsxWorkbook(
  path: string,
  overrides: Partial<XlsxReadLimits> = {},
): Promise<XlsxWorkbook> {
  const limits = { ...DEFAULT_XLSX_READ_LIMITS, ...overrides };
  const pkg = await openZipPackage(path, limits.maxEntries);
  const root = await readRelationships(pkg, "", limits);
  const office = findRelationship(root, REL_SUFFIX.officeDocument);
  const workbookPath = office === undefined ? "xl/workbook.xml" : resolvePart("", office.target);
  const workbookEntry = pkg.entry(workbookPath);
  if (workbookEntry === undefined) throw invalidXlsx("The XLSX package has no workbook part.");
  const relationships = await readRelationships(pkg, workbookPath, limits);

  let date1904 = false;
  const declared: { name: string; id: string | undefined }[] = [];
  await drain(
    parsePart<never>(
      entryChunks(pkg, workbookEntry, limits.maxPartBytes, () =>
        xlsxLimit("The XLSX workbook part exceeds the bounded size limit.", {
          limit: limits.maxPartBytes,
        }),
      ),
      limits,
      () => ({
        open(name, attributes) {
          if (name === "workbookPr") {
            const flag = (attributes.date1904 ?? "").toLowerCase();
            date1904 = flag === "1" || flag === "true";
          } else if (name === "sheet" && attributes.name !== undefined) {
            const idKey = Object.keys(attributes).find(
              (key) => key === "r:id" || key.endsWith(":id"),
            );
            declared.push({
              name: attributes.name,
              id: idKey === undefined ? undefined : attributes[idKey],
            });
          }
        },
        close() {},
        text() {},
      }),
    ),
  );

  const sheets = new Map<string, string | undefined>();
  for (const sheet of declared) {
    const relationship = sheet.id === undefined ? undefined : relationships.get(sheet.id);
    if (relationship !== undefined && !relationship.type.endsWith(REL_SUFFIX.worksheet)) continue;
    if (sheets.has(sheet.name)) throw invalidXlsx("The XLSX workbook declares duplicate sheets.");
    sheets.set(
      sheet.name,
      relationship === undefined ? undefined : resolvePart(workbookPath, relationship.target),
    );
  }

  const sharedRelationship = findRelationship(relationships, REL_SUFFIX.sharedStrings);
  const sharedStrings = pkg.entry(
    sharedRelationship === undefined
      ? "xl/sharedStrings.xml"
      : resolvePart(workbookPath, sharedRelationship.target),
  );
  if (sharedStrings !== undefined && sharedStrings.size > limits.maxSharedStringsBytes)
    throw sharedStringsTooLarge(sharedStrings.size, limits.maxSharedStringsBytes);
  const stylesRelationship = findRelationship(relationships, REL_SUFFIX.styles);
  const styles = pkg.entry(
    stylesRelationship === undefined
      ? "xl/styles.xml"
      : resolvePart(workbookPath, stylesRelationship.target),
  );
  return new WorkbookReader(pkg, limits, sheets, sharedStrings, styles, date1904);
}
