import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDbQueryRunner } from "../src/query.js";
import { buildProfileBatches, profileStagedDatabase } from "../src/profile.js";
import { stageTabularInput } from "../src/tabular-stage.js";

const fixtures = fileURLToPath(new URL("../../testing/fixtures/data/", import.meta.url));
const workerPath = new URL("./fixtures/query-worker-source-entry.ts", import.meta.url);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "klopsi-profile-"));
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

async function staged(input: string): Promise<string> {
  const databasePath = join(directory, "data.duckdb");
  const stage = await stageTabularInput({
    input,
    databasePath,
    xlsxRowsPath: join(directory, "rows.ndjson"),
    xlsxSharedStringsByteLimit: 1024 * 1024,
    preserveDatabaseOnClose: true,
  });
  await stage.connection.run("CHECKPOINT");
  await stage.close();
  return databasePath;
}

async function table(sql: string): Promise<string> {
  const databasePath = join(directory, "data.duckdb");
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE data AS ${sql}`);
    await connection.run("CHECKPOINT");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return databasePath;
}

function profile(databasePath: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  return profileStagedDatabase(new DuckDbQueryRunner({ workerPath }), {
    databasePath,
    invocationDirectory: directory,
    ...options,
  });
}

describe("profileStagedDatabase", () => {
  it("profiles every column of a staged fixture", async () => {
    const result = await profile(await staged(join(fixtures, "valid.csv")));
    expect(result.rowCount).toBe(3);
    expect(result.columns.map((column) => column.column)).toEqual(["id", "mesto", "aktivno"]);
    expect(result.columns[0]).toEqual({
      column: "id",
      type: "BIGINT",
      count: 3,
      nullCount: 0,
      nullPercent: 0,
      distinctApprox: 3,
      min: "1",
      minTruncated: false,
      max: "3",
      maxTruncated: false,
      mean: 2,
      stddev: 1,
    });
    expect(result.columns[1]).toMatchObject({
      column: "mesto",
      type: "VARCHAR",
      count: 3,
      min: "Ljubljana",
      max: "Škofja Loka",
      mean: null,
      stddev: null,
    });
    expect(result.columns[2]).toMatchObject({ type: "BOOLEAN", min: "false", max: "true" });
  });

  it("counts nulls and keeps large integers exact as strings", async () => {
    const input = join(directory, "nulls.csv");
    await writeFile(input, "big,label\n9007199254740993,a\n,\n1,c\n,d\n");
    const result = await profile(await staged(input));
    expect(result.rowCount).toBe(4);
    expect(result.columns[0]).toMatchObject({
      column: "big",
      count: 2,
      nullCount: 2,
      nullPercent: 50,
      min: "1",
      max: "9007199254740993",
    });
    expect(result.columns[1]).toMatchObject({ count: 3, nullCount: 1, nullPercent: 25 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("quotes non-ASCII and punctuated column names safely", async () => {
    const input = join(directory, "names.csv");
    await writeFile(
      input,
      '"Šifra ""občine""","a""); DROP TABLE data; --","x, y",čas\n1,2,3,4\n5,6,7,8\n',
    );
    const result = await profile(await staged(input));
    expect(result.columns.map((column) => column.column)).toEqual([
      'Šifra "občine"',
      'a"); DROP TABLE data; --',
      "x, y",
      "čas",
    ]);
    expect(result.columns.map((column) => column.max)).toEqual(["5", "6", "7", "8"]);
  });

  it("profiles typed JSON and Parquet fixtures", async () => {
    for (const name of ["data.json", "data.ndjson", "data.parquet"]) {
      const result = await profile(await staged(join(fixtures, name)));
      expect(result.rowCount, name).toBe(2);
      expect(
        result.columns.map((column) => column.column),
        name,
      ).toEqual(["id", "mesto"]);
      expect(result.columns[0], name).toMatchObject({ min: "1", max: "2", mean: 1.5 });
      await rm(join(directory, "data.duckdb"), { force: true });
    }
  });

  it("profiles nested JSON columns without ordering them", async () => {
    const input = join(directory, "nested.json");
    await writeFile(
      input,
      JSON.stringify([
        { place: { name: "Ljubljana" }, tags: ["a"], when: "2024-01-02" },
        { place: { name: "Koper" }, tags: ["b", "c"], when: "2025-06-30" },
      ]),
    );
    const result = await profile(await staged(input));
    expect(result.columns.map(({ column, min, max }) => ({ column, min, max }))).toEqual([
      { column: "place", min: null, max: null },
      { column: "tags", min: null, max: null },
      { column: "when", min: "2024-01-02", max: "2025-06-30" },
    ]);
    expect(result.columns[0]).toMatchObject({ count: 2, distinctApprox: 2 });
  });

  it("returns null percentages and statistics for an empty table", async () => {
    const input = join(directory, "empty.csv");
    await writeFile(input, "a,b\n");
    const result = await profile(await staged(input));
    expect(result.rowCount).toBe(0);
    expect(result.columns[0]).toMatchObject({
      count: 0,
      nullCount: 0,
      nullPercent: null,
      min: null,
      max: null,
      mean: null,
      stddev: null,
    });
  });

  it("maps cancellation to the query failure category", async () => {
    const databasePath = await staged(join(fixtures, "valid.csv"));
    const controller = new AbortController();
    controller.abort();
    await expect(profile(databasePath, { signal: controller.signal })).rejects.toMatchObject({
      code: "QUERY_CANCELLED",
      exitCode: 7,
    });
  });

  it("rejects an exhausted deadline as a query timeout", async () => {
    const databasePath = await staged(join(fixtures, "valid.csv"));
    await expect(
      profileStagedDatabase(new DuckDbQueryRunner({ workerPath }), {
        databasePath,
        invocationDirectory: directory,
        timeoutMs: 1,
        now: (() => {
          let tick = 0;
          return () => (tick += 10);
        })(),
      }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT", exitCode: 7 });
  });
});

describe("profileStagedDatabase edge cases", () => {
  it("excludes NaN and infinities from mean and stddev of float columns", async () => {
    const input = join(directory, "nan.csv");
    await writeFile(input, "x,y\n1.5,a\nNaN,b\n2.5,c\ninf,d\n");
    const result = await profile(await staged(input));
    expect(result.columns[0]).toMatchObject({
      column: "x",
      type: "DOUBLE",
      count: 4,
      mean: 2,
      stddev: Math.SQRT1_2,
    });
  });

  it("does not fail on float magnitudes whose squares overflow", async () => {
    const result = await profile(
      await table("SELECT * FROM (VALUES (1e200::DOUBLE), (-1e300::DOUBLE), (3::DOUBLE)) t(x)"),
    );
    expect(result.columns[0]).toMatchObject({ count: 3, min: "-1e+300", max: "1e+200" });
    expect(result.columns[0]?.mean).toBeTypeOf("number");
  });

  it("truncates long min and max text to 256 characters", async () => {
    const input = join(directory, "long.csv");
    await writeFile(input, `id,text\n1,${"b".repeat(1_100_000)}\n2,${"a".repeat(300)}\n`);
    const result = await profile(await staged(input));
    expect(result.columns[1]).toMatchObject({
      min: "a".repeat(256),
      minTruncated: true,
      max: "b".repeat(256),
      maxTruncated: true,
    });
    expect(result.columns[0]).toMatchObject({ minTruncated: false, maxTruncated: false });
  });

  it("profiles a table wider than one batch end to end", async () => {
    const projections = Array.from({ length: 450 }, (_, index) => `${index} AS "col ${index}"`);
    const result = await profile(await table(`SELECT ${projections.join(", ")}`));
    expect(result.rowCount).toBe(1);
    expect(result.columns).toHaveLength(450);
    expect(result.columns[449]).toMatchObject({ column: "col 449", min: "449", count: 1 });
  });

  it("reports all-null columns and single-row stddev as null", async () => {
    const result = await profile(await table("SELECT NULL::INTEGER AS empty, 7 AS one"));
    expect(result.columns[0]).toMatchObject({
      count: 0,
      nullCount: 1,
      nullPercent: 100,
      distinctApprox: 0,
      min: null,
      max: null,
      mean: null,
      stddev: null,
    });
    expect(result.columns[1]).toMatchObject({ count: 1, mean: 7, stddev: null });
  });

  it("profiles DECIMAL and HUGEINT columns exactly", async () => {
    const result = await profile(
      await table(
        "SELECT * FROM (VALUES (1.25::DECIMAL(18,2), 170141183460469231731687303715884105727::HUGEINT), (2.75::DECIMAL(18,2), -5::HUGEINT)) t(d, h)",
      ),
    );
    expect(result.columns[0]).toMatchObject({
      type: "DECIMAL(18,2)",
      min: "1.25",
      max: "2.75",
      mean: 2,
    });
    expect(result.columns[1]).toMatchObject({
      type: "HUGEINT",
      min: "-5",
      max: "170141183460469231731687303715884105727",
    });
  });

  it("renders TIMESTAMPTZ min and max in UTC regardless of host timezone", async () => {
    const databasePath = await table(
      "SELECT * FROM (VALUES ('2024-01-01 10:00:00+02'::TIMESTAMPTZ), ('2024-06-30 23:30:00-01'::TIMESTAMPTZ)) t(ts)",
    );
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const result = await profile(databasePath);
      expect(result.columns[0]).toMatchObject({
        type: "TIMESTAMP WITH TIME ZONE",
        min: "2024-01-01 08:00:00+00",
        max: "2024-07-01 00:30:00+00",
      });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("clamps the distinct estimate to the non-null count", async () => {
    const result = await profile(await table("SELECT range::VARCHAR AS v FROM range(5000)"));
    expect(result.columns[0]?.distinctApprox).toBeLessThanOrEqual(5000);
  });

  it("counts rows when the table has no columns to batch", async () => {
    const calls: string[] = [];
    const result = await profileStagedDatabase(
      {
        executePrepared: async (options) => {
          calls.push(options.sql);
          return calls.length === 1
            ? { columns: [], rows: [], returnedCount: 0, truncated: false, sql: options.sql }
            : {
                columns: ["row_count"],
                rows: [{ row_count: "4" }],
                returnedCount: 1,
                truncated: false,
                sql: options.sql,
              };
        },
      },
      { databasePath: "unused", invocationDirectory: directory },
    );
    expect(result).toEqual({ rowCount: 4, columns: [] });
    expect(calls[1]).toBe("SELECT count(*) AS row_count FROM data");
  });
});

describe("buildProfileBatches", () => {
  it("splits wide tables into bounded single-SELECT batches", () => {
    const columns = Array.from({ length: 500 }, (_, index) => ({
      name: `column ${index} "quoted"`,
      type: index % 2 === 0 ? "DOUBLE" : "VARCHAR",
    }));
    const batches = buildProfileBatches(columns);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.columns)).toEqual(columns);
    for (const batch of batches) {
      expect(batch.columns.length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(batch.sql, "utf8")).toBeLessThan(64 * 1024);
      expect(batch.sql).toMatch(/^WITH t AS \(SELECT /u);
    }
    expect(batches[0]?.sql).toContain('"column 0 ""quoted""" AS c0');
  });

  it("rejects a column name too long to profile within the SQL limit", () => {
    expect(() => buildProfileBatches([{ name: "x".repeat(70_000), type: "VARCHAR" }])).toThrow(
      expect.objectContaining({ code: "QUERY_SQL_TOO_LARGE", exitCode: 7 }),
    );
  });
});
