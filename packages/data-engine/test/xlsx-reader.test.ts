import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataEngine } from "../src/index.js";
import { createRequire } from "node:module";
import { unzipRaw } from "unzipit";
import { classifyNumberFormat, openXlsxWorkbook, type XlsxRow } from "../src/xlsx-reader.js";
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

const DATE_STYLES =
  `<numFmts count="9"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>` +
  `<numFmt numFmtId="165" formatCode="&quot;day &quot;0.00"/>` +
  `<numFmt numFmtId="166" formatCode="[Red][&lt;0]0.0;[h]:mm"/>` +
  `<numFmt numFmtId="167" formatCode="h:mm"/><numFmt numFmtId="168" formatCode="[h]:mm:ss"/>` +
  `<numFmt numFmtId="169" formatCode="yyyy-mm-dd hh:mm:ss.000"/><numFmt numFmtId="170" formatCode="mm:ss"/>` +
  `<numFmt numFmtId="171" formatCode="d/m/yyyy h:mm AM/PM"/></numFmts>` +
  `<cellXfs count="12"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/>` +
  `<xf numFmtId="10"/><xf numFmtId="22"/><xf numFmtId="167"/><xf numFmtId="168"/><xf numFmtId="169"/>` +
  `<xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="166"/></cellXfs>` +
  // Differential formats may reuse ids; they must not replace the cell formats.
  `<dxfs count="1"><dxf><numFmt numFmtId="164" formatCode="0.00"/></dxf></dxfs>`;

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
          rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>`,
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
      ["  padded  ", "Bold and plain", "line\rbreak & <tag> _x0041_", "cdata <raw>"],
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

  it("classifies number formats as date, date-time, time, elapsed, or numeric", () => {
    expect(
      Object.fromEntries(
        [
          "yyyy-mm-dd",
          "d-mmm-yy",
          "mmm yyyy",
          "dd/mm/yyyy hh:mm",
          "m/d/yy h:mm AM/PM",
          "h:mm",
          "mm:ss",
          "h:mm:ss.0",
          "[h]:mm:ss",
          "[mm]:ss",
          '"day "0.00',
          "0.00E+00",
          "#,##0.00\\ [$EUR]",
          "General",
          "[Red][<0]0.0;[h]:mm",
        ].map((code) => [code, classifyNumberFormat(code) ?? "number"]),
      ),
    ).toEqual({
      "yyyy-mm-dd": "date",
      "d-mmm-yy": "date",
      "mmm yyyy": "date",
      "dd/mm/yyyy hh:mm": "datetime",
      "m/d/yy h:mm AM/PM": "datetime",
      "h:mm": "time",
      "mm:ss": "time",
      "h:mm:ss.0": "time",
      "[h]:mm:ss": "elapsed",
      "[mm]:ss": "elapsed",
      '"day "0.00': "number",
      "0.00E+00": "number",
      "#,##0.00\\ [$EUR]": "number",
      General: "number",
      "[Red][<0]0.0;[h]:mm": "number",
    });
  });

  it("reads dates as wall-clock text and keeps times, elapsed values, and out-of-range serials numeric", async () => {
    const cells: readonly [string, string][] = [
      ["1", "45293"],
      ["2", "45293.5"],
      ["3", "45293"],
      ["4", "0.25"],
      ["5", "45293.5"],
      ["1", "1"],
      ["1", "59"],
      ["99", "3"],
      ["6", "0.5"],
      ["7", "1.5"],
      ["8", "45293.000005787037"],
      ["9", "0.25"],
      ["10", "45293.75"],
      ["1", "-1"],
      ["1", "2958466"],
      ["11", "5"],
    ];
    const dateRow = `<row r="1">${cells.map(([style, value]) => `<c s="${style}"><v>${value}</v></c>`).join("")}<c t="d"><v>2024-01-02T03:04:05</v></c></row>`;
    const path1900 = await writeFixtureXlsx(join(root, "dates-1900.xlsx"), {
      sheets: [{ name: "D", rows: dateRow }],
      styles: DATE_STYLES,
    });
    expect(values(await readAll(path1900, "D"))).toEqual([
      [
        "2024-01-02",
        "2024-01-02",
        45293,
        0.25,
        "2024-01-02T12:00:00",
        "1900-01-01",
        "1900-02-28",
        3,
        0.5,
        1.5,
        "2024-01-02T00:00:00.500",
        0.25,
        "2024-01-02T18:00:00",
        -1,
        2958466,
        5,
        "2024-01-02T03:04:05",
      ],
    ]);
    const path1904 = await writeFixtureXlsx(join(root, "dates-1904.xlsx"), {
      sheets: [
        {
          name: "D",
          rows: `<row r="1"><c s="1"><v>0</v></c><c s="2"><v>43831</v></c><c s="5"><v>0.5</v></c></row>`,
        },
      ],
      styles: DATE_STYLES,
      date1904: true,
    });
    expect(values(await readAll(path1904, "D"))).toEqual([
      ["1904-01-01", "2024-01-02", "1904-01-01T12:00:00"],
    ]);
  });

  it("rejects shared-string indexes outside the table", async () => {
    const path = await writeFixtureXlsx(join(root, "shared-index.xlsx"), {
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="s"><v>99</v></c></row>` }],
      sharedStrings: [`<si><t>only</t></si>`],
    });
    await expect(readAll(path, "S")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it.each([
    [
      "text inside an ignored element",
      `<extLst><ext uri="x">${"x>".repeat(100_000)}</ext></extLst>`,
    ],
    ["attribute", `<extLst foo="${"a".repeat(200_000)}"/>`],
    ["comment", `<!--${"a<".repeat(100_000)}-->`],
    ["CDATA section", `<extLst><![CDATA[${"<a>".repeat(70_000)}]]></extLst>`],
  ])("bounds a huge %s before saxes buffers it", async (_kind, hostile) => {
    const path = join(root, "huge-node.xlsx");
    const entries = xlsxEntries({ sheets: [{ name: "H", rows: "" }] });
    entries["xl/worksheets/sheet1.xml"] =
      `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c><v>1</v></c></row></sheetData>${hostile}</worksheet>`;
    await writeFile(path, zipEntries(entries));
    const workbook = await openXlsxWorkbook(path, { maxCellChars: 1_024 });
    await expect(
      (async () => {
        for await (const value of workbook.rows("H")) void value;
      })(),
    ).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
  });

  it("keeps legitimate long cells within the run-length bound", async () => {
    const text = "&".repeat(1_024);
    const path = await writeFixtureXlsx(join(root, "long-cell.xlsx"), {
      sheets: [{ name: "L", rows: rows([[text], ["after"]]) }],
    });
    const workbook = await openXlsxWorkbook(path, { maxCellChars: 1_024 });
    const read: XlsxRow[] = [];
    for await (const value of workbook.rows("L")) read.push(value);
    expect(values(read)).toEqual([[text], ["after"]]);
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

  it("rejects local ZIP headers that disagree with the central directory", async () => {
    const entries = xlsxEntries({ sheets: [{ name: "X", rows: rows([[1]]) }] });
    const name = Buffer.from("xl/worksheets/sheet1.xml");

    const renamed = Buffer.from(zipEntries(entries));
    const local = renamed.indexOf(name);
    expect(renamed.readUInt32LE(local - 30)).toBe(0x04034b50);
    renamed[local + name.length - 5] = "2".charCodeAt(0);
    const renamedPath = join(root, "local-name.xlsx");
    await writeFile(renamedPath, renamed);
    await expect(readAll(renamedPath, "X")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });

    const restored = Buffer.from(zipEntries(entries));
    const header = restored.indexOf(name) - 30;
    restored.writeUInt16LE(0, header + 8);
    const methodPath = join(root, "local-method.xlsx");
    await writeFile(methodPath, restored);
    await expect(readAll(methodPath, "X")).rejects.toMatchObject({ code: "INVALID_XLSX_DATA" });
  });

  it("depends on unzipit 1.4.3 internals (_rawEntry); revisit xlsx-zip.ts before bumping", async () => {
    const version = (
      createRequire(import.meta.url)("unzipit/package.json") as { readonly version: string }
    ).version;
    expect(
      version,
      "xlsx-zip.ts reads unzipit's private ZipEntry._rawEntry; re-verify its shape before changing the pin",
    ).toBe("1.4.3");
    const zip = zipEntries(xlsxEntries({ sheets: [{ name: "X", rows: rows([[1]]) }] }));
    const { entries } = await unzipRaw(zip);
    const raw = (entries[0] as unknown as { readonly _rawEntry: Record<string, unknown> })
      ._rawEntry;
    expect(raw).toMatchObject({
      relativeOffsetOfLocalHeader: expect.any(Number),
      compressionMethod: expect.any(Number),
      generalPurposeBitFlag: expect.any(Number),
      crc32: expect.any(Number),
    });
  });

  it.each([
    ["openpyxl", null],
    ["xlsxwriter", 3],
  ] as const)(
    "reads a workbook written by %s (generate-real-world-xlsx.py)",
    async (writer, cachedDouble) => {
      const path = resolve(`packages/testing/fixtures/data/${writer}.xlsx`);
      const workbook = await openXlsxWorkbook(path);
      expect(workbook.sheetNames).toEqual(["Data", "Hidden"]);
      expect(values(await readAll(path, "Data"))).toEqual([
        ["label", "amount", "day", "moment", "clock", "doubled"],
        ["Ljubljana", 1.5, "2024-01-02", "2024-01-02T03:04:05", 0.5208333333333334, { f: "B2*2" }],
        ["Ljubljana", 2, "1999-12-31", "2000-02-29T23:59:59", 0.25, { f: "B3*2" }],
      ]);
      const cached = await readAll(path, "Data");
      expect(cached[1]?.cells[5]?.value).toBe(cachedDouble);
      expect(values(await readAll(path, "Hidden"))).toEqual([["secret"], [42]]);

      const preview = await new DataEngine().preview(path, { sheet: "Data" });
      expect(preview.rows[0]).toMatchObject({ day: "2024-01-02", doubled: "=B2*2" });
      expect(preview.warnings).toContainEqual(expect.objectContaining({ code: "FORMULA_CELL" }));
    },
  );

  it("stages wall-clock dates so DuckDB infers DATE and TIMESTAMP columns", async () => {
    const input = resolve("packages/testing/fixtures/data/xlsxwriter.xlsx");
    const output = join(root, "real-world.parquet");
    const engine = new DataEngine();
    await engine.convert({ input, output, targetFormat: "parquet", sheet: "Data", force: false });
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const literal = `'${output.replaceAll("'", "''")}'`;
      const described = await connection.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet(${literal})`,
      );
      expect(
        Object.fromEntries(
          described.getRowObjectsJS().map((row) => [row.column_name, row.column_type]),
        ),
      ).toMatchObject({ day: "DATE", moment: "TIMESTAMP", clock: "DOUBLE", amount: "DOUBLE" });
      const moments = await connection.runAndReadAll(
        `SELECT strftime(moment, '%Y-%m-%d %H:%M:%S') AS moment FROM read_parquet(${literal}) ORDER BY moment`,
      );
      expect(moments.getRowObjectsJS()).toEqual([
        { moment: "2000-02-29 23:59:59" },
        { moment: "2024-01-02 03:04:05" },
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const schema = await engine.inferSchema(input, { sheet: "Data" });
    expect(schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "day", type: "date" }),
        expect.objectContaining({ name: "moment", type: "timestamp" }),
      ]),
    );
  });
});
