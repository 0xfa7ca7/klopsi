import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataEngine } from "../src/index.js";
import { openXlsxWorkbook, type XlsxRow } from "../src/xlsx-reader.js";
import { row, rows, writeFixtureXlsx, xlsxEntries, zipEntries } from "./xlsx-fixture.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "klopsi-xlsx-reader-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

async function readAll(path: string, sheet: string): Promise<XlsxRow[]> {
  const workbook = await openXlsxWorkbook(path);
  const result: XlsxRow[] = [];
  for await (const value of workbook.rows(sheet)) result.push(value);
  return result;
}

function values(rowsRead: readonly XlsxRow[]): unknown[][] {
  return rowsRead.map((value) =>
    Array.from(value.cells, (cell) =>
      cell === undefined ? null : cell.formula === undefined ? cell.value : { f: cell.formula },
    ),
  );
}

/** Offset of the central-directory header for an entry name. */
function centralEntry(zip: Buffer, name: Buffer): number {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (
    let offset = zip.indexOf(signature);
    offset >= 0;
    offset = zip.indexOf(signature, offset + 4)
  ) {
    const nameLength = zip.readUInt16LE(offset + 28);
    if (zip.subarray(offset + 46, offset + 46 + nameLength).equals(name)) return offset;
  }
  throw new Error(`missing central entry ${name.toString()}`);
}

const DATE_STYLES = `<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="&quot;day &quot;0.00"/><numFmt numFmtId="166" formatCode="[Red][&lt;0]0.0;[h]:mm"/></numFmts><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="10"/><xf numFmtId="22"/></cellXfs>`;

describe("bounded XLSX reader", () => {
  it("lists worksheets in workbook order and skips chartsheets", async () => {
    const path = await writeFixtureXlsx(join(root, "sheets.xlsx"), {
      sheets: [
        { name: "Zeta", rows: rows([["z"]]) },
        {
          name: "Chart",
          rows: "",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet",
          target: "chartsheets/sheet1.xml",
        },
        { name: "Alpha & Omega", rows: rows([["a"]]), target: "/xl/custom/data.xml" },
      ],
    });
    const workbook = await openXlsxWorkbook(path);
    expect(workbook.sheetNames).toEqual(["Zeta", "Alpha & Omega"]);
    expect(values(await readAll(path, "Alpha & Omega"))).toEqual([["a"]]);
  });

  it("decodes shared strings with rich-text runs, phonetic runs, whitespace, and escapes", async () => {
    const path = await writeFixtureXlsx(join(root, "shared.xlsx"), {
      sheets: [
        {
          name: "S",
          rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>99</v></c></row>`,
        },
      ],
      sharedStrings: [
        `<si><t xml:space="preserve">  padded  </t></si>`,
        `<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>`,
        `<si><t>line_x000D_break &amp; &lt;tag&gt; _x005F_x0041_</t></si>`,
        `<si><t><![CDATA[cdata <raw>]]></t></si>`,
      ],
    });
    expect(values(await readAll(path, "S"))).toEqual([
      ["  padded  ", "Bold and plain", "line\rbreak & <tag> _x0041_", "cdata <raw>", null],
    ]);
  });

  it("decodes inline strings, numbers, booleans, errors, formulas, and sparse cells", async () => {
    const path = await writeFixtureXlsx(join(root, "types.xlsx"), {
      sheets: [
        {
          name: "T",
          rows:
            `<row r="1"><c r="A1" t="inlineStr"><is><r><t>rich</t></r><r><t xml:space="preserve"> inline</t></r></is></c>` +
            `<c r="B1"><v>1.5e3</v></c><c r="C1" t="b"><v>0</v></c><c r="D1" t="e"><v>#N/A</v></c>` +
            `<c r="F1" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="H1" s="1"/></row>` +
            `<row r="3"><c t="n"><v>-7</v></c><c><v>  </v></c><c t="b"><v>1</v></c></row>` +
            `<row r="4"/>` +
            `<row><c r="B5"><f t="shared" si="0"/><v>4</v></c></row>`,
        },
      ],
    });
    const read = await readAll(path, "T");
    expect(read.map((value) => value.number)).toEqual([1, 3, 4, 5]);
    expect(values(read)).toEqual([
      ["rich inline", 1500, false, "#N/A", null, { f: '"x"&"y"' }, null, null],
      [-7, null, true],
      [],
      [null, { f: "" }],
    ]);
    expect(read[3]?.cells[1]?.value).toBe(4);
  });

  it("converts built-in and custom date formats in the 1900 and 1904 systems", async () => {
    const dateRow = `<row r="1"><c r="A1" s="1"><v>45293</v></c><c r="B1" s="2"><v>45293.5</v></c><c r="C1" s="3"><v>45293</v></c><c r="D1" s="4"><v>0.25</v></c><c r="E1" s="5"><v>1</v></c><c r="F1" s="1"><v>59</v></c><c r="G1" t="d"><v>2024-01-02T03:04:05Z</v></c><c r="H1" s="99"><v>3</v></c></row>`;
    const path1900 = await writeFixtureXlsx(join(root, "dates-1900.xlsx"), {
      sheets: [{ name: "D", rows: dateRow }],
      styles: DATE_STYLES,
    });
    expect(values(await readAll(path1900, "D"))).toEqual([
      [
        "2024-01-02T00:00:00.000Z",
        "2024-01-02T12:00:00.000Z",
        45293,
        0.25,
        "1900-01-01T00:00:00.000Z",
        "1900-02-28T00:00:00.000Z",
        "2024-01-02T03:04:05.000Z",
        3,
      ],
    ]);
    const path1904 = await writeFixtureXlsx(join(root, "dates-1904.xlsx"), {
      sheets: [
        {
          name: "D",
          rows: `<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="2"><v>43831</v></c></row>`,
        },
      ],
      styles: DATE_STYLES,
      date1904: true,
    });
    expect(values(await readAll(path1904, "D"))).toEqual([
      ["1904-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z"],
    ]);
  });

  it("treats elapsed-time custom formats as dates", async () => {
    const path = await writeFixtureXlsx(join(root, "elapsed.xlsx"), {
      sheets: [{ name: "E", rows: `<row r="1"><c r="A1" s="1"><v>1.5</v></c></row>` }],
      styles: `<numFmts count="1"><numFmt numFmtId="170" formatCode="[h]:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="170"/></cellXfs>`,
    });
    expect(values(await readAll(path, "E"))).toEqual([["1900-01-01T12:00:00.000Z"]]);
  });

  it("stops streaming when the consumer stops early", async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => row(index + 1, [index])).join("");
    const path = await writeFixtureXlsx(join(root, "many.xlsx"), {
      sheets: [{ name: "M", rows: many }],
    });
    const workbook = await openXlsxWorkbook(path);
    let count = 0;
    for await (const _value of workbook.rows("M")) {
      void _value;
      count += 1;
      if (count === 3) break;
    }
    expect(count).toBe(3);
  });

  it("rejects DTDs and entity declarations", async () => {
    const path = join(root, "dtd.xlsx");
    const entries = xlsxEntries({ sheets: [{ name: "X", rows: "" }] });
    entries["xl/worksheets/sheet1.xml"] =
      `<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY boom "boom">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&boom;</t></is></c></row></sheetData></worksheet>`;
    await writeFile(path, zipEntries(entries));
    await expect(readAll(path, "X")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("rejects non-ZIP input, duplicate entries, and relationship targets outside the package", async () => {
    const notZip = join(root, "not.xlsx");
    await writeFile(notZip, "PK\u0003\u0004 definitely not a zip");
    await expect(openXlsxWorkbook(notZip)).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });

    const escaping = await writeFixtureXlsx(join(root, "escape.xlsx"), {
      sheets: [{ name: "X", rows: "", target: "../../../etc/passwd" }],
    });
    await expect(readAll(escaping, "X")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });

    const duplicate = join(root, "duplicate.xlsx");
    const bytes = Buffer.from(
      zipEntries({
        ...xlsxEntries({ sheets: [{ name: "X", rows: rows([[1]]) }] }),
        "xl/dup1.xml": "a",
        "xl/dup2.xml": "b",
      }),
    );
    // Rename the second entry in place so the central directory lists one path twice.
    await writeFile(
      duplicate,
      Buffer.from(bytes.toString("latin1").replaceAll("xl/dup2.xml", "xl/dup1.xml"), "latin1"),
    );
    await expect(openXlsxWorkbook(duplicate)).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("rejects cells and rows beyond the spreadsheet grid", async () => {
    const wide = await writeFixtureXlsx(join(root, "wide.xlsx"), {
      sheets: [{ name: "W", rows: `<row r="1"><c r="XFE1"><v>1</v></c></row>` }],
    });
    await expect(readAll(wide, "W")).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
    const tall = await writeFixtureXlsx(join(root, "tall.xlsx"), {
      sheets: [{ name: "T", rows: `<row r="1048577"><c><v>1</v></c></row>` }],
    });
    await expect(readAll(tall, "T")).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
  });

  it("bounds worksheet bytes and cell text", async () => {
    const path = await writeFixtureXlsx(join(root, "big.xlsx"), {
      sheets: [{ name: "B", rows: row(1, ["x".repeat(4_096)]) }],
    });
    const small = await openXlsxWorkbook(path, { maxWorksheetBytes: 1_024 });
    await expect(
      (async () => {
        for await (const value of small.rows("B")) void value;
      })(),
    ).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
    const narrow = await openXlsxWorkbook(path, { maxCellChars: 1_024 });
    await expect(
      (async () => {
        for await (const value of narrow.rows("B")) void value;
      })(),
    ).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
  });

  it("detects entries whose inflated size disagrees with the ZIP directory", async () => {
    const path = join(root, "lying.xlsx");
    const entries = xlsxEntries({ sheets: [{ name: "L", rows: row(1, ["y".repeat(10_000)]) }] });
    const sheet = Buffer.from(entries["xl/worksheets/sheet1.xml"] as string);
    const zip = Buffer.from(zipEntries(entries));
    // Patch the central-directory uncompressed size of the worksheet entry to a smaller value.
    const central = centralEntry(zip, Buffer.from("xl/worksheets/sheet1.xml"));
    expect(zip.readUInt32LE(central + 24)).toBe(sheet.length);
    zip.writeUInt32LE(100, central + 24);
    await writeFile(path, zip);
    await expect(readAll(path, "L")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("detects corrupted entry data through the CRC", async () => {
    const path = join(root, "crc.xlsx");
    const entries = xlsxEntries({ sheets: [{ name: "C", rows: row(1, ["abc"]) }] });
    const zip = Buffer.from(zipEntries(entries));
    const central = centralEntry(zip, Buffer.from("xl/worksheets/sheet1.xml"));
    zip.writeUInt32LE((zip.readUInt32LE(central + 16) ^ 0xffff) >>> 0, central + 16);
    await writeFile(path, zip);
    await expect(readAll(path, "C")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("enforces the shared-string limit on inflated bytes, not only declared sizes", async () => {
    const path = join(root, "shared-bomb.xlsx");
    const entries = xlsxEntries({
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` }],
      sharedStrings: [`<si><t>${"z".repeat(50_000)}</t></si>`],
    });
    const zip = Buffer.from(zipEntries(entries));
    const central = centralEntry(zip, Buffer.from("xl/sharedStrings.xml"));
    zip.writeUInt32LE(10, central + 24);
    await writeFile(path, zip);
    const workbook = await openXlsxWorkbook(path, { maxSharedStringsBytes: 1_024 });
    await expect(
      (async () => {
        for await (const value of workbook.rows("S")) void value;
      })(),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(XLSX_SHARED_STRINGS_TOO_LARGE|INVALID_XLSX_DATA)$/u),
    });
  });

  it("rejects encrypted and unsupported-compression entries", async () => {
    const path = join(root, "stored.xlsx");
    const entries = xlsxEntries({ sheets: [{ name: "X", rows: rows([[1]]) }] });
    const zip = Buffer.from(zipEntries(entries));
    const central = centralEntry(zip, Buffer.from("xl/worksheets/sheet1.xml"));
    zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 1, central + 8);
    await writeFile(path, zip);
    await expect(readAll(path, "X")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("surfaces formula cells and hostile files through the DataEngine preview", async () => {
    const path = await writeFixtureXlsx(join(root, "engine.xlsx"), {
      sheets: [
        {
          name: "Data",
          rows: rows([
            ["a", "b"],
            [{ formula: "1+1" }, "x"],
          ]),
        },
      ],
    });
    const preview = await new DataEngine().preview(path, { sheet: "Data" });
    expect(preview.rows).toEqual([{ a: "=1+1", b: "x" }]);
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ code: "FORMULA_CELL", row: 2, column: 1 }),
    );
    await expect(new DataEngine().preview(path, { sheet: "Nope" })).rejects.toMatchObject({
      code: "SHEET_NOT_FOUND",
    });
  });
});
