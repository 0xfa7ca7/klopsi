import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataEngine, writeXlsx } from "../src/index.js";
import { rows as fixtureRows, writeFixtureXlsx } from "./xlsx-fixture.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";

const engine = new DataEngine();
const temporary: string[] = [];

async function fixture(contents: string, name = "input.csv"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "klopsi-validate-"));
  temporary.push(directory);
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("data validation", () => {
  it("fully validates PC-Axis DATA and preserves source symbol warnings", async () => {
    const valid = await fixture(
      `AXIS-VERSION="2024";
CODEPAGE="utf-8";
MATRIX="valid";
STUB="Place";
VALUES("Place")="A","B";
DATA=1 ".";`,
      "valid.px",
    );

    await expect(engine.validate(valid)).resolves.toMatchObject({
      valid: true,
      format: "pcaxis",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "PCAXIS_DATA_SYMBOL",
          severity: "warning",
          context: { symbol: ".", occurrences: 1 },
        }),
      ]),
      schema: expect.objectContaining({ format: "pcaxis", sampledRows: 2 }),
    });

    const values = Array.from({ length: 501 }, (_, index) => `"v${index}"`).join(",");
    const short = await fixture(
      `AXIS-VERSION="2024";CODEPAGE="utf-8";MATRIX="short";STUB="Row";VALUES("Row")=${values};DATA=${Array.from(
        { length: 500 },
        (_, index) => index,
      ).join(" ")};`,
      "short.px",
    );
    await expect(engine.validate(short)).rejects.toMatchObject({
      code: "PCAXIS_CELL_COUNT_MISMATCH",
      exitCode: 6,
      context: { expected: 501, actual: 500 },
    });
  });

  it("rejects PC-Axis DATA without a final semicolon during full validation", async () => {
    const path = await fixture(
      `CODEPAGE="utf-8";MATRIX="unterminated";STUB="Row";VALUES("Row")="A","B";DATA=1 2`,
      "unterminated.px",
    );

    await expect(engine.validate(path)).rejects.toMatchObject({
      code: "INVALID_PCAXIS_DATA",
      exitCode: 6,
    });
  });

  it("applies shared validation bounds to PC-Axis rows", async () => {
    const path = await fixture(
      `AXIS-VERSION="2024";CODEPAGE="utf-8";MATRIX="bounded";STUB="Row";VALUES("Row")="A","B";DATA=1 2;`,
      "bounded.px",
    );

    await expect(new DataEngine({ validationMaxRecords: 1 }).validate(path)).rejects.toMatchObject({
      code: "VALIDATION_RECORD_LIMIT",
      exitCode: 5,
      context: { limit: 1 },
    });
  });

  it("preserves typed PC-Axis errors raised during schema inference", async () => {
    const path = await fixture(
      `AXIS-VERSION="2024";CODEPAGE="utf-8";MATRIX="typed";STUB="Row";VALUES("Row")="A";DATA=1;`,
      "typed.px",
    );
    const typed = new KlopsiError({
      code: "PCAXIS_CELL_LIMIT",
      message: "schema preview limit exceeded",
      exitCode: EXIT_CODES.INTEGRITY_FAILURE,
      context: { phase: "schema" },
    });
    const schemaFailingEngine = new DataEngine({
      onAdapter: (name) => {
        if (name === "pcaxis") throw typed;
      },
    });

    await expect(schemaFailingEngine.validate(path)).rejects.toBe(typed);
  });

  it("reports malformed row widths with stable locations and does not mutate input", async () => {
    const path = resolve("packages/testing/fixtures/data/malformed.csv");
    const before = await readFile(path);

    const result = await engine.validate(path);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "INCONSISTENT_COLUMN_COUNT",
        severity: "error",
        row: 3,
        recommendation: expect.any(String),
      }),
    );
    expect(await readFile(path)).toEqual(before);
  });

  it("reports duplicate headers, duplicate rows, mixed types, and null-heavy columns", async () => {
    const path = await fixture(
      "id,id,value,mostly_empty\n1,a,10,\n1,a,10,\n2,b,text,\n3,c,12,present\n",
    );

    const codes = (await engine.validate(path)).issues.map((issue) => issue.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_HEADER",
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
      ]),
    );
  });

  it("reports invalid date-like values and spreadsheet-formula-looking values", async () => {
    const path = await fixture(
      "date,value\n2026-01-01,=2+2\n2026-99-99,+cmd\n2026-02-03,-1\n2026-02-04,@SUM(A1)\n",
    );

    const result = await engine.validate(path);

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_DATE", row: 3, field: "date" }),
    );
    expect(result.issues.filter((issue) => issue.code === "FORMULA_LIKE_VALUE")).toHaveLength(4);
  });

  it("reports delimiter mismatches and invalid UTF-8 encoding", async () => {
    const delimiter = await fixture("a\tb\n1\t2\n", "wrong.csv");
    const invalid = await fixture("placeholder", "invalid.csv");
    await writeFile(invalid, Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0x2c, 0x32]));

    await expect(engine.validate(delimiter)).resolves.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "DELIMITER_MISMATCH" })]),
    });
    await expect(engine.validate(invalid)).resolves.toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_ENCODING", severity: "error" }),
      ]),
    });
  });

  it("preserves unsupported and sheet-selection statuses during validation", async () => {
    const zip = await fixture("PK\u0003\u0004fixture", "archive.zip");

    await expect(engine.validate(zip)).rejects.toMatchObject({
      code: "DOWNLOAD_ONLY_FORMAT",
      exitCode: 5,
    });
    await expect(
      engine.validate(resolve("packages/testing/fixtures/data/data.xlsx")),
    ).rejects.toMatchObject({ code: "SHEET_REQUIRED", exitCode: 2 });
  });

  it("runs row diagnostics for structured formats", async () => {
    const path = await fixture(
      JSON.stringify([
        { date: "2026-01-01", value: "=2+2", mostly: null },
        { date: "2026-01-01", value: "=2+2", mostly: null },
        { date: "2026-99-99", value: 3, mostly: "present" },
      ]),
      "diagnostic.json",
    );

    const codes = (await engine.validate(path)).issues.map((candidate) => candidate.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
        "INVALID_DATE",
        "FORMULA_LIKE_VALUE",
      ]),
    );
  });

  it("strictly validates NDJSON beyond the schema sample boundary", async () => {
    const path = await fixture(
      `${Array.from({ length: 550 }, (_, id) => JSON.stringify({ id })).join("\n")}\n{broken\n`,
      "late-error.ndjson",
    );

    await expect(engine.validate(path)).resolves.toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "PARSE_ERROR" })]),
    });
  });

  it("runs JSON diagnostics across rows beyond the preview sample", async () => {
    const rows = Array.from({ length: 1_100 }, (_, id) => ({
      id,
      date: "2026-01-01",
      value: "safe",
      mostly: id < 500 ? "present" : (null as string | null),
    }));
    rows[520] = { id: 520, date: "2026-99-99", value: "=2+2", mostly: null };
    rows[521] = { ...rows[520] };
    rows[522] = { id: 522, date: "2026-01-01", value: "3", mostly: null };
    const path = await fixture(JSON.stringify(rows), "late-diagnostics.json");

    const codes = (await engine.validate(path)).issues.map((candidate) => candidate.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
        "INVALID_DATE",
        "FORMULA_LIKE_VALUE",
      ]),
    );
  });

  it("runs NDJSON diagnostics across rows beyond the preview sample", async () => {
    const rows = Array.from({ length: 1_100 }, (_, id) => ({
      id,
      date: "2026-01-01",
      value: "safe",
      mostly: id < 500 ? "present" : null,
    }));
    rows[520] = { id: 520, date: "2026-99-99", value: "=2+2", mostly: null };
    rows[521] = { ...rows[520] };
    rows[522] = { id: 522, date: "2026-01-01", value: "3", mostly: null };
    const path = await fixture(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "late-diagnostics.ndjson",
    );

    const codes = (await engine.validate(path)).issues.map((candidate) => candidate.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
        "INVALID_DATE",
        "FORMULA_LIKE_VALUE",
      ]),
    );
  });

  it("streams XLSX diagnostics across rows beyond the preview sample", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-xlsx-validation-"));
    temporary.push(directory);
    const path = join(directory, "late.xlsx");
    const sheetRows: (string | number | null)[][] = [["id", "date", "value", "mostly"]];
    for (let id = 0; id < 1_100; id += 1)
      sheetRows.push([
        id,
        id === 525 ? "2026-99-99" : "2026-01-01",
        id === 525 ? "=2+2" : id === 526 ? "3" : "safe",
        id < 500 ? "present" : null,
      ]);
    sheetRows.push([525, "2026-99-99", "=2+2", null]);
    await writeXlsx(path, [{ name: "Rows", rows: sheetRows }]);

    const codes = (await engine.validate(path, { sheet: "Rows" })).issues.map(
      (candidate) => candidate.code,
    );

    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
        "INVALID_DATE",
        "FORMULA_LIKE_VALUE",
      ]),
    );
  }, 20_000);

  it("scans Parquet diagnostics across rows beyond the preview sample", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-parquet-validation-"));
    temporary.push(directory);
    const path = join(directory, "late.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const escaped = path.replaceAll("'", "''");
      await connection.run(
        `COPY (SELECT i AS id, CASE WHEN i = 525 THEN '2026-99-99' ELSE '2026-01-01' END AS date, CASE WHEN i = 525 THEN '=2+2' WHEN i = 526 THEN '3' ELSE 'safe' END AS value, CASE WHEN i < 500 THEN 'present' ELSE NULL END AS mostly FROM range(1100) t(i) UNION ALL SELECT 525, '2026-99-99', '=2+2', NULL) TO '${escaped}' (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const codes = (await engine.validate(path)).issues.map((candidate) => candidate.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ROW",
        "MIXED_TYPES",
        "NULL_HEAVY_COLUMN",
        "INVALID_DATE",
        "FORMULA_LIKE_VALUE",
      ]),
    );
  }, 20_000);

  it("preserves JSON-looking Parquet VARCHAR values exactly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-parquet-strings-"));
    temporary.push(directory);
    const path = join(directory, "strings.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT * FROM (VALUES ('null'), ('true'), ('[1]'), ('{"a":1}')) t(value)) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    await expect(engine.preview(path)).resolves.toMatchObject({
      rows: [{ value: "null" }, { value: "true" }, { value: "[1]" }, { value: '{"a":1}' }],
    });
    await expect(engine.validate(path)).resolves.toMatchObject({ valid: true });
  });

  it("enforces validation row, record, total-byte, and column bounds", async () => {
    const exact = await fixture('{"a":"1"}\n{"a":"2"}\n', "exact.ndjson");
    await expect(
      new DataEngine({
        validationMaxRecords: 2,
        validationMaxRecordBytes: 9,
        validationMaxTotalBytes: 18,
        validationMaxColumns: 1,
      }).validate(exact),
    ).resolves.toMatchObject({ valid: true });
    await expect(new DataEngine({ validationMaxRecords: 1 }).validate(exact)).rejects.toMatchObject(
      { code: "VALIDATION_RECORD_LIMIT", exitCode: 5 },
    );
    await expect(
      new DataEngine({ validationMaxRecordBytes: 4 }).validate(exact),
    ).rejects.toMatchObject({ code: "VALIDATION_RECORD_TOO_LARGE", exitCode: 5 });
    await expect(
      new DataEngine({ validationMaxTotalBytes: 17 }).validate(exact),
    ).rejects.toMatchObject({ code: "VALIDATION_TOTAL_BYTES_LIMIT", exitCode: 5 });
    const wide = await fixture('{"a":1,"b":2}\n', "wide.ndjson");
    await expect(new DataEngine({ validationMaxColumns: 1 }).validate(wide)).rejects.toMatchObject({
      code: "VALIDATION_COLUMN_LIMIT",
      exitCode: 5,
    });
  });

  it("applies the shared streaming bounds to CSV without retaining the full file", async () => {
    const path = await fixture(
      `id,value\n${Array.from({ length: 20 }, (_, id) => `${id},x`).join("\n")}\n`,
    );
    await expect(new DataEngine({ validationMaxRecords: 10 }).validate(path)).rejects.toMatchObject(
      {
        code: "VALIDATION_RECORD_LIMIT",
        exitCode: 5,
      },
    );
    await expect(
      new DataEngine({ validationMaxTotalBytes: 20 }).validate(path),
    ).rejects.toMatchObject({ code: "VALIDATION_TOTAL_BYTES_LIMIT", exitCode: 5 });
    const wide = await fixture("a,b\n1,2\n", "wide.csv");
    await expect(new DataEngine({ validationMaxColumns: 1 }).validate(wide)).rejects.toMatchObject({
      code: "VALIDATION_COLUMN_LIMIT",
      exitCode: 5,
    });
  });

  it("bounds retained state and aggregates repeated issues", async () => {
    const repeated = await fixture(
      `${Array.from({ length: 100 }, () => '{"value":"=x","date":"2026-99-99"}').join("\n")}\n`,
      "repeated.ndjson",
    );
    const result = await new DataEngine({
      validationMaxStateBytes: 10_000,
      validationMaxIssueGroups: 10,
    }).validate(repeated);
    expect(result.issues.filter((candidate) => candidate.code === "FORMULA_LIKE_VALUE")).toEqual([
      expect.objectContaining({ context: expect.objectContaining({ occurrenceCount: 100 }) }),
    ]);
    await expect(
      new DataEngine({ validationMaxStateBytes: 20 }).validate(repeated),
    ).rejects.toMatchObject({ code: "VALIDATION_STATE_LIMIT", exitCode: 5 });
    await expect(
      new DataEngine({ validationMaxIssueGroups: 1 }).validate(repeated),
    ).rejects.toMatchObject({ code: "VALIDATION_ISSUE_LIMIT", exitCode: 5 });
  });

  it("treats absent trailing XLSX cells as nulls within the header width", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-xlsx-trailing-nulls-"));
    temporary.push(directory);
    const path = join(directory, "trailing-nulls.xlsx");
    await writeXlsx(path, [
      {
        name: "Rows",
        rows: [
          ["id", "note"],
          [1, null],
          [2, "present"],
        ],
      },
    ]);

    const result = await engine.validate(path, { sheet: "Rows" });

    expect(result).toMatchObject({
      valid: true,
      errors: [],
      schema: {
        fields: expect.arrayContaining([expect.objectContaining({ name: "note", nullable: true })]),
      },
    });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "INCONSISTENT_COLUMN_COUNT" }),
    );
  });

  it("validates XLSX headers and preserves extra-cell width errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-xlsx-headers-"));
    temporary.push(directory);
    const path = join(directory, "headers.xlsx");
    await writeXlsx(path, [
      {
        name: "Rows",
        rows: [
          ["a", "a", ""],
          [1, 2, 3, 4],
        ],
      },
      { name: "Wide", rows: [["a", "b"]] },
    ]);
    const result = await engine.validate(path, { sheet: "Rows" });
    expect(result.issues.map((candidate) => candidate.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_HEADER", "EMPTY_HEADER", "INCONSISTENT_COLUMN_COUNT"]),
    );
    await expect(
      new DataEngine({ validationMaxColumns: 1 }).validate(path, { sheet: "Wide" }),
    ).rejects.toMatchObject({ code: "VALIDATION_COLUMN_LIMIT", exitCode: 5 });
  });

  it("charges XLSX headers and header formulas to shared budgets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "klopsi-xlsx-header-budget-"));
    temporary.push(directory);
    const path = join(directory, "header-budget.xlsx");
    await writeFixtureXlsx(path, {
      sheets: [
        {
          name: "Rows",
          rows: fixtureRows([[{ formula: '"danger"', result: "danger" }, "x".repeat(200)]]),
        },
      ],
    });
    await expect(
      new DataEngine({ validationMaxRecordBytes: 40 }).validate(path, { sheet: "Rows" }),
    ).rejects.toMatchObject({ code: "VALIDATION_RECORD_TOO_LARGE", exitCode: 5 });
    const result = await new DataEngine({ validationMaxRecordBytes: 1_000 }).validate(path, {
      sheet: "Rows",
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "FORMULA_CELL",
        row: 1,
        context: expect.objectContaining({ occurrenceCount: 1 }),
      }),
    );
  });

  it("applies shared row/record/total/column limits to JSON and Parquet", async () => {
    const json = await fixture('[{"a":"12345","b":2},{"a":"67890","b":3}]', "limits.json");
    await expect(new DataEngine({ validationMaxRecords: 1 }).validate(json)).rejects.toMatchObject({
      code: "VALIDATION_RECORD_LIMIT",
    });
    await expect(
      new DataEngine({ validationMaxRecordBytes: 5 }).validate(json),
    ).rejects.toMatchObject({ code: "VALIDATION_RECORD_TOO_LARGE" });
    await expect(
      new DataEngine({ validationMaxTotalBytes: 10 }).validate(json),
    ).rejects.toMatchObject({ code: "VALIDATION_TOTAL_BYTES_LIMIT" });
    await expect(new DataEngine({ validationMaxColumns: 1 }).validate(json)).rejects.toMatchObject({
      code: "VALIDATION_COLUMN_LIMIT",
    });
    const directory = await mkdtemp(join(tmpdir(), "klopsi-parquet-limits-"));
    temporary.push(directory);
    const parquet = join(directory, "limits.parquet");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT * FROM (VALUES ('12345', 2), ('67890', 3)) t(a,b)) TO '${parquet}' (FORMAT PARQUET)`,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    await expect(
      new DataEngine({ validationMaxRecords: 1 }).validate(parquet),
    ).rejects.toMatchObject({ code: "VALIDATION_RECORD_LIMIT" });
    await expect(
      new DataEngine({ validationMaxRecordBytes: 5 }).validate(parquet),
    ).rejects.toMatchObject({ code: "VALIDATION_RECORD_TOO_LARGE" });
    await expect(
      new DataEngine({ validationMaxTotalBytes: 10 }).validate(parquet),
    ).rejects.toMatchObject({ code: "VALIDATION_TOTAL_BYTES_LIMIT" });
    await expect(
      new DataEngine({ validationMaxColumns: 1 }).validate(parquet),
    ).rejects.toMatchObject({ code: "VALIDATION_COLUMN_LIMIT" });
  }, 20_000);
});
