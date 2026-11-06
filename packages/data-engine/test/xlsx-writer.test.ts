import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataEngine, detectFormat, writeXlsx } from "../src/index.js";
import { openXlsxWorkbook } from "../src/xlsx-reader.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "klopsi-xlsx-writer-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

async function readValues(path: string, sheet: string): Promise<unknown[][]> {
  const workbook = await openXlsxWorkbook(path);
  const result: unknown[][] = [];
  for await (const value of workbook.rows(sheet))
    result.push(Array.from(value.cells, (cell) => (cell === undefined ? null : cell.value)));
  return result;
}

describe("streaming XLSX writer", () => {
  it("round-trips strings, numbers, booleans, nulls, and dates", async () => {
    const path = join(root, "roundtrip.xlsx");
    const hostile = [
      `<tag attr="x">&amp; 'quote'</tag>`,
      "]]> <![CDATA[ x ]]>",
      "control\u0001\u0008\u000b\u001f end",
      "tab\tnew\nline\r\nreturn",
      "  leading and trailing  ",
      "literal _x0041_ and _x005F_",
      "emoji 🧪 and Šč",
      "lone \ud800 surrogate",
      "=SUM(A1:A2)",
      "",
    ];
    await writeXlsx(path, [
      {
        name: "Data",
        rows: (async function* () {
          yield ["text", "number", "flag", "when"];
          for (const [index, text] of hostile.entries())
            yield [text, index + 0.5, index % 2 === 0, null];
          yield [null, -1e21, false, new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6))];
          yield [null, Number.MAX_SAFE_INTEGER, null, new Date(Date.UTC(1900, 0, 1))];
        })(),
      },
    ]);
    const values = await readValues(path, "Data");
    expect(values[0]).toEqual(["text", "number", "flag", "when"]);
    expect(values.slice(1, hostile.length + 1).map((row) => row[0])).toEqual(
      hostile.map((text) => text.replace("\ud800", "\ufffd")),
    );
    expect(values.slice(1, hostile.length + 1).map((row) => row[1])).toEqual(
      hostile.map((_text, index) => index + 0.5),
    );
    expect(values[hostile.length + 1]).toEqual([null, -1e21, false, "2024-01-02T03:04:05.006"]);
    expect(values[hostile.length + 2]).toEqual([
      null,
      Number.MAX_SAFE_INTEGER,
      null,
      "1900-01-01T00:00:00",
    ]);
  });

  it("writes deterministic, well-formed OOXML packages", async () => {
    const first = join(root, "first.xlsx");
    const second = join(root, "second.xlsx");
    const rows = [
      ["a", "b"],
      [1, "x & y"],
    ] as const;
    await writeXlsx(first, [{ name: "Data", rows }]);
    await writeXlsx(second, [{ name: "Data", rows }]);
    const bytes = await readFile(first);
    expect(bytes.equals(await readFile(second))).toBe(true);

    const entries = unzipSync(bytes);
    expect(Object.keys(entries)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = strFromU8(entries["xl/worksheets/sheet1.xml"] as Uint8Array);
    expect(sheet).toContain(
      '<c r="B2" t="inlineStr"><is><t xml:space="preserve">x &amp; y</t></is></c>',
    );
    expect(sheet).toContain('<c r="A2"><v>1</v></c>');
    expect(sheet).not.toContain("<f>");
    const types = strFromU8(entries["[Content_Types].xml"] as Uint8Array);
    expect(types).toContain(
      'PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"',
    );
    await expect(detectFormat(first)).resolves.toMatchObject({ format: "xlsx" });
  });

  it("supports several sheets and rejects invalid sheet names", async () => {
    const path = join(root, "multi.xlsx");
    await writeXlsx(path, [
      { name: "One", rows: [["a"], [1]] },
      { name: "Two & <Three>", rows: [["b"], [true]] },
    ]);
    expect((await openXlsxWorkbook(path)).sheetNames).toEqual(["One", "Two & <Three>"]);
    expect(await readValues(path, "Two & <Three>")).toEqual([["b"], [true]]);

    for (const name of ["", "a/b", "x".repeat(32), "History'", "[x]"])
      await expect(
        writeXlsx(join(root, `bad-${name.length}.xlsx`), [{ name, rows: [] }]),
      ).rejects.toMatchObject({
        code: "INVALID_XLSX_SHEET_NAME",
      });
    await expect(
      writeXlsx(join(root, "duplicate.xlsx"), [
        { name: "Same", rows: [] },
        { name: "same", rows: [] },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_XLSX_SHEET_NAME" });
  });

  it("rejects rows wider than the spreadsheet grid", async () => {
    await expect(
      writeXlsx(join(root, "wide.xlsx"), [
        { name: "Wide", rows: [Array.from({ length: 16_385 }, () => 1)] },
      ]),
    ).rejects.toMatchObject({ code: "XLSX_LIMIT_EXCEEDED" });
  });

  it("converts to XLSX with spreadsheet-safe prefixes and never emits formulas", async () => {
    const input = join(root, "formula.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      input,
      JSON.stringify([
        { label: "=2+2", amount: 1, at: "2024-01-02T03:04:05Z" },
        { label: "@cmd <x>&", amount: 2.5, at: null },
      ]),
    );
    const engine = new DataEngine();
    const safe = join(root, "safe.xlsx");
    await engine.convert({
      input,
      output: safe,
      targetFormat: "xlsx",
      force: false,
      spreadsheetSafe: true,
    });
    const sheet = strFromU8(
      unzipSync(await readFile(safe))["xl/worksheets/sheet1.xml"] as Uint8Array,
    );
    expect(sheet).not.toContain("<f>");
    const preview = await engine.preview(safe, { sheet: "Data" });
    expect(preview.columns).toEqual(["label", "amount", "at"]);
    expect(preview.rows).toEqual([
      { label: "'=2+2", amount: 1, at: "2024-01-02T03:04:05" },
      { label: "'@cmd <x>&", amount: 2.5, at: null },
    ]);
  });
});
