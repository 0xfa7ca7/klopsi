import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let input: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "klopsi-query-e2e-"));
  input = join(home, "input.csv");
  await writeFile(input, "city,value\nLjubljana,1\nMaribor,2\nKoper,3\n");
});
afterEach(async () => rm(home, { recursive: true, force: true }));

async function cli(argv: readonly string[], env: NodeJS.ProcessEnv = {}, stdin?: string) {
  const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...argv], {
    cwd: home,
    env: {
      ...process.env,
      ...env,
      HOME: home,
      KLOPSI_CACHE_DIR: join(home, "cache"),
      NO_COLOR: "1",
    },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (stdin !== undefined) child.stdin?.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [exitCode] = (await once(child, "exit")) as [number];
  let json: unknown;
  try {
    json = JSON.parse(stdout) as unknown;
  } catch {
    json = undefined;
  }
  return { exitCode, stdout, stderr, json };
}

describe("query CLI", () => {
  it("reports a transparent miss followed by a hit", async () => {
    const argv = ["query", input, "--sql", "SELECT * FROM data ORDER BY city", "--json"];
    const first = await cli(argv);
    const second = await cli(argv);
    expect(first).toMatchObject({
      exitCode: 0,
      stderr: "",
      json: { meta: { cache: { status: "miss", kind: "duckdb-stage" } } },
    });
    expect(second).toMatchObject({
      exitCode: 0,
      stderr: "",
      json: { data: (first.json as { data: unknown }).data, meta: { cache: { status: "hit" } } },
    });
  });

  it("reports bypass when the derived cache budget is zero", async () => {
    await expect(
      cli(["query", input, "--sql", "SELECT * FROM data", "--json"], {
        KLOPSI_DUCKDB_CACHE_MAX_BYTES: "0B",
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      json: { meta: { cache: { status: "bypass", kind: "duckdb-stage" } } },
    });
  });

  it("exposes derived cache information and maintenance through cache commands", async () => {
    await cli(["query", input, "--sql", "SELECT * FROM data", "--json"]);
    await expect(cli(["cache", "info", "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { derived: { objects: 1, bytes: expect.any(Number) } } },
    });
    await expect(cli(["cache", "list", "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: [expect.objectContaining({ kind: "duckdb-stage" })] },
    });
    await expect(cli(["cache", "verify", "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { errors: [] } },
    });
    await expect(cli(["cache", "prune", "--yes", "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { derivedExpiredRemoved: 0, derivedLruRemoved: 0 } },
    });
    await expect(cli(["cache", "clear", "--yes", "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { cleared: true } },
    });
  });

  it("queries only the data table and includes executed SQL metadata", async () => {
    const sql = "SELECT city, value FROM data ORDER BY city";
    await expect(cli(["query", input, "--sql", sql, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      json: {
        data: [
          { city: "Koper", value: "3" },
          { city: "Ljubljana", value: "1" },
          { city: "Maribor", value: "2" },
        ],
        meta: { sql, returnedCount: 3, truncated: false, source: input },
      },
    });
  });

  it.each([
    ["--ndjson", /^\{"city":"Ljubljana","value":"1"\}\n/u],
    ["--csv", /^city,value\nLjubljana,1\n/u],
    ["--tsv", /^city\tvalue\nLjubljana\t1\n/u],
  ])("renders %s rows", async (flag, expected) => {
    const result = await cli(["query", input, "--sql", "SELECT * FROM data LIMIT 1", flag]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(expected);
  });

  it("reports truncation and maps forbidden SQL and timeout to exit 7", async () => {
    await expect(
      cli(["query", input, "--sql", "SELECT * FROM data", "--limit", "1", "--json"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      json: { meta: { returnedCount: 1, truncated: true } },
    });
    await expect(cli(["query", input, "--sql", "PRAGMA version", "--json"])).resolves.toMatchObject(
      {
        exitCode: 7,
        json: { error: { code: "QUERY_FORBIDDEN" } },
      },
    );
    await expect(
      cli([
        "query",
        input,
        "--sql",
        "SELECT sum(a.i * b.i) FROM range(1000000000) a(i), range(1000000000) b(i)",
        "--timeout-ms",
        "100",
        "--json",
      ]),
    ).resolves.toMatchObject({ exitCode: 7, json: { error: { code: "QUERY_TIMEOUT" } } });
  });

  it("exports bounded results with query provenance", async () => {
    const output = join(home, "result.csv");
    const sql = "SELECT city FROM data ORDER BY city LIMIT 2";
    await expect(
      cli(["query", input, "--sql", sql, "--output", output, "--json"]),
    ).resolves.toMatchObject({ exitCode: 0, json: { meta: { sql }, data: expect.any(Array) } });
    expect(await readFile(output, "utf8")).toBe("city\nKoper\nLjubljana\n");
    await expect(cli(["provenance", "verify", output, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { valid: true } },
    });
    const provenance = JSON.parse(await readFile(`${output}.provenance.json`, "utf8")) as {
      transformations: { operation: string; details?: { sql?: string } }[];
    };
    expect(provenance.transformations).toEqual([
      expect.objectContaining({ operation: "query", details: expect.objectContaining({ sql }) }),
    ]);
  });

  it.each([
    ["csv", "city,value\n"],
    ["tsv", "city\tvalue\n"],
  ])("exports known headers for an empty %s query result", async (format, expected) => {
    const output = join(home, `empty.${format}`);
    await expect(
      cli([
        "query",
        input,
        "--sql",
        "SELECT city, value FROM data WHERE false",
        "--output",
        output,
        "--json",
      ]),
    ).resolves.toMatchObject({ exitCode: 0, json: { data: [] } });
    expect(await readFile(output, "utf8")).toBe(expected);
  });
});

describe("query CLI SQL files and parameters", () => {
  it("reads SQL from a UTF-8 file with a byte order mark", async () => {
    const sql = "SELECT city FROM data WHERE city = 'Koper'\n";
    await writeFile(join(home, "query.sql"), `\ufeff${sql}`);
    await expect(cli(["query", input, "--sql-file", "query.sql", "--json"])).resolves.toMatchObject(
      {
        exitCode: 0,
        stderr: "",
        json: { data: [{ city: "Koper" }], meta: { sql } },
      },
    );
  });

  it("reads SQL from stdin with --sql-file -", async () => {
    await expect(
      cli(
        ["query", input, "--sql-file", "-", "--json"],
        {},
        "SELECT count(*)::INTEGER AS n FROM data",
      ),
    ).resolves.toMatchObject({ exitCode: 0, json: { data: [{ n: 3 }] } });
  });

  it("requires exactly one SQL source", async () => {
    await expect(cli(["query", input, "--json"])).resolves.toMatchObject({
      exitCode: 2,
      json: { error: { code: "QUERY_SQL_REQUIRED", exitCode: 2 } },
    });
    await writeFile(join(home, "query.sql"), "SELECT 1");
    const both = await cli(["query", input, "--sql", "SELECT 1", "--sql-file", "query.sql"]);
    expect(both.exitCode).toBe(2);
    expect(both.stderr).toMatch(/cannot be used with/u);
  });

  it("reports typed SQL file errors", async () => {
    await expect(
      cli(["query", input, "--sql-file", "missing.sql", "--json"]),
    ).resolves.toMatchObject({
      exitCode: 3,
      json: { error: { code: "QUERY_SQL_FILE_NOT_FOUND" } },
    });
    await writeFile(join(home, "bad.sql"), Buffer.from([0x53, 0xe8]));
    await expect(cli(["query", input, "--sql-file", "bad.sql", "--json"])).resolves.toMatchObject({
      exitCode: 2,
      json: { error: { code: "QUERY_SQL_FILE_ENCODING" } },
    });
    await expect(cli(["query", input, "--sql-file", ".", "--json"])).resolves.toMatchObject({
      exitCode: 2,
      json: { error: { code: "QUERY_SQL_FILE_INVALID" } },
    });
    await writeFile(join(home, "write.sql"), "DROP TABLE data");
    await expect(cli(["query", input, "--sql-file", "write.sql", "--json"])).resolves.toMatchObject(
      { exitCode: 7, json: { error: { code: "QUERY_FORBIDDEN" } } },
    );
  });

  it("binds repeatable named parameters and reports them in meta", async () => {
    const sql =
      "SELECT city FROM data WHERE CAST(value AS BIGINT) >= $min AND city <> $skip ORDER BY city";
    await expect(
      cli([
        "query",
        input,
        "--sql",
        sql,
        "--param",
        "min:int=2",
        "--param",
        "skip=Koper",
        "--json",
      ]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      json: {
        data: [{ city: "Maribor" }],
        meta: {
          sql,
          parameters: [
            { name: "min", type: "int", value: "2" },
            { name: "skip", type: "varchar", value: "Koper" },
          ],
        },
      },
    });
  });

  it("omits parameter metadata when no parameters are bound", async () => {
    const result = await cli(["query", input, "--sql", "SELECT 1 AS x", "--json"]);
    expect(result.exitCode).toBe(0);
    expect((result.json as { meta: Record<string, unknown> }).meta).not.toHaveProperty(
      "parameters",
    );
  });

  it.each(["'; DROP TABLE data; --", "Koper' OR '1'='1", "x'); COPY data TO 'leak.csv'; --"])(
    "treats an injected parameter value as data: %s",
    async (value) => {
      await expect(
        cli([
          "query",
          input,
          "--sql",
          "SELECT $q AS q, count(*)::INTEGER AS n FROM data WHERE city = $q",
          "--param",
          `q=${value}`,
          "--json",
        ]),
      ).resolves.toMatchObject({ exitCode: 0, json: { data: [{ q: value, n: 0 }] } });
      await expect(
        cli(["query", input, "--sql", "SELECT count(*)::INTEGER AS n FROM data", "--json"]),
      ).resolves.toMatchObject({ exitCode: 0, json: { data: [{ n: 3 }] } });
      await expect(readFile(join(home, "leak.csv"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    [["--param", "nameonly"], "QUERY_PARAM_INVALID"],
    [["--param", "1bad=x"], "QUERY_PARAM_INVALID"],
    [["--param", "n:int=abc"], "QUERY_PARAM_INVALID"],
    [["--param", "n:uuid=abc"], "QUERY_PARAM_INVALID"],
    [["--param", "d:date=2023-02-29"], "QUERY_PARAM_INVALID"],
    [["--param", "q=a", "--param", "Q=b"], "QUERY_PARAM_DUPLICATE"],
  ])("rejects invalid parameters %j with exit 2", async (flags, code) => {
    await expect(
      cli(["query", input, "--sql", "SELECT $q AS q", ...flags, "--json"]),
    ).resolves.toMatchObject({ exitCode: 2, json: { error: { code, exitCode: 2 } } });
  });

  it("reports missing and unused parameters with exit 2", async () => {
    await expect(cli(["query", input, "--sql", "SELECT $q AS q", "--json"])).resolves.toMatchObject(
      {
        exitCode: 2,
        json: { error: { code: "QUERY_PARAM_MISSING", context: { missing: ["q"] } } },
      },
    );
    await expect(
      cli(["query", input, "--sql", "SELECT 1 AS x", "--param", "q=a", "--json"]),
    ).resolves.toMatchObject({
      exitCode: 2,
      json: { error: { code: "QUERY_PARAM_UNUSED", context: { unused: ["q"] } } },
    });
  });

  it("records SQL and parameters in export provenance", async () => {
    const output = join(home, "filtered.csv");
    const sql = "SELECT city FROM data WHERE city = $city";
    await writeFile(join(home, "filtered.sql"), sql);
    await expect(
      cli([
        "query",
        input,
        "--sql-file",
        "filtered.sql",
        "--param",
        "city=Maribor",
        "--output",
        output,
        "--json",
      ]),
    ).resolves.toMatchObject({ exitCode: 0, json: { data: [{ city: "Maribor" }] } });
    expect(await readFile(output, "utf8")).toBe("city\nMaribor\n");
    const provenance = JSON.parse(await readFile(`${output}.provenance.json`, "utf8")) as {
      schemaVersion: string;
      transformations: { operation: string; details?: Record<string, unknown> }[];
    };
    expect(provenance.schemaVersion).toBe("1");
    expect(provenance.transformations).toEqual([
      expect.objectContaining({
        operation: "query",
        details: {
          sql,
          parameters: [{ name: "city", type: "varchar", value: "Maribor" }],
        },
      }),
    ]);
    await expect(cli(["provenance", "verify", output, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { valid: true } },
    });
  });
});
