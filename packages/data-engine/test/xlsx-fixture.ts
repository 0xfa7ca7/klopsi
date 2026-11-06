import { writeFile } from "node:fs/promises";
import { strToU8, zipSync, type Zippable } from "fflate";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

export interface FixtureSheet {
  readonly name: string;
  /** Inner XML of <sheetData>. */
  readonly rows: string;
  readonly target?: string;
  readonly type?: string;
}

export interface FixtureWorkbook {
  readonly sheets: readonly FixtureSheet[];
  readonly sharedStrings?: readonly string[];
  /** Inner XML of <styleSheet>. */
  readonly styles?: string;
  readonly date1904?: boolean;
  /** Raw entries that replace or extend the generated package. */
  readonly extra?: Readonly<Record<string, string | Uint8Array>>;
}

/** A formula cell, optionally with the cached result a spreadsheet application stores. */
export interface FixtureFormula {
  readonly formula: string;
  readonly result?: string | number;
}

export function sheetXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${rows}</sheetData></worksheet>`;
}

export function xlsxEntries(workbook: FixtureWorkbook): Record<string, string | Uint8Array> {
  const relationships = workbook.sheets.map(
    (sheet, index) =>
      `<Relationship Id="rId${index + 1}" Type="${sheet.type ?? `${REL}/worksheet`}" Target="${sheet.target ?? `worksheets/sheet${index + 1}.xml`}"/>`,
  );
  const entries: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}">${workbook.date1904 === true ? '<workbookPr date1904="1"/>' : ""}<sheets>${workbook.sheets.map((sheet, index) => `<sheet name="${escape(sheet.name).replaceAll('"', "&quot;")}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
  };
  if (workbook.sharedStrings !== undefined) {
    relationships.push(
      `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`,
    );
    entries["xl/sharedStrings.xml"] =
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}">${workbook.sharedStrings.join("")}</sst>`;
  }
  if (workbook.styles !== undefined) {
    relationships.push(`<Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/>`);
    entries["xl/styles.xml"] =
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}">${workbook.styles}</styleSheet>`;
  }
  entries["xl/_rels/workbook.xml.rels"] =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${relationships.join("")}</Relationships>`;
  workbook.sheets.forEach((sheet, index) => {
    const target = sheet.target ?? `worksheets/sheet${index + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    entries[path] = sheetXml(sheet.rows);
  });
  return { ...entries, ...workbook.extra };
}

export function zipEntries(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, value] of Object.entries(entries))
    zippable[name] = typeof value === "string" ? strToU8(value) : value;
  return zipSync(zippable, { mtime: new Date("2020-01-01T00:00:00Z") });
}

export async function writeFixtureXlsx(path: string, workbook: FixtureWorkbook): Promise<string> {
  await writeFile(path, zipEntries(xlsxEntries(workbook)));
  return path;
}

/** Shorthand for a row of literal cells: numbers, booleans, null, inline strings, or formulas. */
export function row(
  number: number,
  values: readonly (string | number | boolean | null | FixtureFormula)[],
): string {
  const cells = values.map((value, index) => {
    const ref = `${columnName(index + 1)}${number}`;
    if (value === null) return "";
    if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
    if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    if (typeof value === "object") {
      const formula = `<f>${escape(value.formula)}</f>`;
      if (value.result === undefined) return `<c r="${ref}">${formula}</c>`;
      return typeof value.result === "number"
        ? `<c r="${ref}">${formula}<v>${value.result}</v></c>`
        : `<c r="${ref}" t="str">${formula}<v>${escape(value.result)}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  });
  return `<row r="${number}">${cells.join("")}</row>`;
}

export function rows(
  values: readonly (readonly (string | number | boolean | null | FixtureFormula)[])[],
): string {
  return values.map((value, index) => row(index + 1, value)).join("");
}

function columnName(column: number): string {
  let name = "";
  for (let remaining = column; remaining > 0; remaining = Math.floor((remaining - 1) / 26))
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
  return name;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
