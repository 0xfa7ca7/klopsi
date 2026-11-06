import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDbQueryRunner } from "../src/query.js";
import { executeQueryWorker, finalizeQueryWorkerResources } from "../src/query-worker.js";
import { stageTabularInput, verifyStagedDatabase } from "../src/tabular-stage.js";

let directory: string;
let input: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "klopsi-query-security-"));
  input = join(directory, "data.csv");
  await writeFile(input, "name,value\na,1\nb,2\nc,3\n");
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

describe("DuckDbQueryRunner security", () => {
  it("attempts every worker cleanup and preserves the query error when cleanup also fails", () => {
    const calls: string[] = [];
    const queryError = new Error("query failed");
    let received: unknown;
    try {
      finalizeQueryWorkerResources(
        {
          prepared: {
            destroySync() {
              calls.push("prepared");
              throw new Error("prepared cleanup failed");
            },
          },
          connection: {
            closeSync() {
              calls.push("connection");
              throw new Error("connection cleanup failed");
            },
          },
          instance: {
            closeSync() {
              calls.push("instance");
            },
          },
        },
        queryError,
      );
    } catch (error) {
      received = error;
    }
    expect(calls).toEqual(["prepared", "connection", "instance"]);
    expect(received).toMatchObject({
      code: "QUERY_CLEANUP_FAILED",
      exitCode: 7,
      context: { failureCount: 2, operationMessage: "query failed" },
      cause: expect.objectContaining({
        errors: [queryError, expect.any(Error), expect.any(Error)],
      }),
    });
  });

  it("documents DuckDB 1.5 rejecting an explicit temp directory on read-only open", async () => {
    const database = join(directory, "probe.duckdb");
    const writable = await DuckDBInstance.create(database);
    const writableConnection = await writable.connect();
    await writableConnection.run("CREATE TABLE data AS SELECT 1 AS value");
    writableConnection.closeSync();
    writable.closeSync();
    await mkdir(join(directory, "spill"));
    await expect(async () => {
      const readOnly = await DuckDBInstance.create(database, {
        access_mode: "READ_ONLY",
        enable_external_access: "false",
        autoinstall_known_extensions: "false",
        autoload_known_extensions: "false",
        allow_community_extensions: "false",
        memory_limit: "1GB",
        temp_directory: join(directory, "spill"),
      });
      try {
        await readOnly.connect();
      } finally {
        readOnly.closeSync();
      }
    }).rejects.toThrow("Failed to set config");
  });
  it.each([
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM read_text('/etc/passwd')",
    "SELECT * FROM read_blob('/etc/passwd')",
    "SELECT * FROM read_json('/etc/passwd')",
    "SELECT * FROM read_parquet('/etc/passwd')",
    "SELECT * FROM glob('/etc/*')",
    "SELECT * FROM read_csv('https://example.invalid/data.csv')",
  ])("denies external reads: %s", async (sql) => {
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    await expect(runner.execute({ input, sql })).rejects.toMatchObject({ exitCode: 7 });
  });

  it("imports only data and applies limit plus one truncation", async () => {
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    await expect(
      runner.execute({ input, sql: "SELECT * FROM data ORDER BY value", rowLimit: 2 }),
    ).resolves.toMatchObject({
      columns: ["name", "value"],
      rows: [
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ],
      returnedCount: 2,
      truncated: true,
      sql: "SELECT * FROM data ORDER BY value",
    });
  });

  it("queries PC-Axis columns after deterministic case-insensitive allocation", async () => {
    input = join(directory, "case-collisions.px");
    await writeFile(
      input,
      `CODEPAGE="utf-8";
MATRIX="case collisions";
STUB="Region","region","VALUE","VALUE__SYMBOL","Region__CODE";
VALUES("Region")="North";
CODES("Region")="R1";
VALUES("region")="South";
CODES("region")="r1";
VALUES("VALUE")="Measure";
VALUES("VALUE__SYMBOL")="Status";
VALUES("Region__CODE")="Generated collision";
CODES("Region__CODE")="RC";
DATA=7;`,
    );
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });

    await expect(
      runner.execute({
        input,
        sql: 'SELECT "Region", "region__2", "VALUE__2", "VALUE__SYMBOL__2", "Region__CODE__2", "Region__CODE__2__code", value FROM data',
      }),
    ).resolves.toMatchObject({
      columns: [
        "Region",
        "region__2",
        "VALUE__2",
        "VALUE__SYMBOL__2",
        "Region__CODE__2",
        "Region__CODE__2__code",
        "value",
      ],
      rows: [
        {
          Region: "North",
          region__2: "South",
          VALUE__2: "Measure",
          VALUE__SYMBOL__2: "Status",
          Region__CODE__2: "Generated collision",
          Region__CODE__2__code: "RC",
          value: "7",
        },
      ],
    });
  });

  it("locks security and resource settings before parsing user SQL", async () => {
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    const result = await runner.execute({
      input,
      sql: `SELECT
        current_setting('enable_external_access') AS external,
        current_setting('autoinstall_known_extensions') AS autoinstall,
        current_setting('autoload_known_extensions') AS autoload,
        current_setting('allow_community_extensions') AS community,
        current_setting('allow_unsigned_extensions') AS unsigned,
        current_setting('memory_limit') AS memory,
        current_setting('lock_configuration') AS locked`,
    });
    expect(result.rows).toEqual([
      {
        external: false,
        autoinstall: false,
        autoload: false,
        community: false,
        unsigned: false,
        memory: "953.6 MiB",
        locked: true,
      },
    ]);
    await expect(
      runner.execute({ input, sql: "SELECT set_config('enable_external_access', 'true', false)" }),
    ).rejects.toMatchObject({ exitCode: 7 });
  });

  it("enforces the exact decimal 1GB worker memory ceiling", async () => {
    let directoriesCreated = 0;
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
      makeTemporaryDirectory: async () => {
        directoriesCreated += 1;
        return await mkdtemp(join(tmpdir(), "klopsi-query-memory-"));
      },
    });
    await expect(
      runner.execute({ input, sql: "SELECT 1", memoryLimit: "1GB" }),
    ).resolves.toMatchObject({ rows: [{ "1": 1 }] });
    await expect(
      runner.execute({ input, sql: "SELECT 1", memoryLimit: "100GB" }),
    ).rejects.toMatchObject({ code: "QUERY_MEMORY_LIMIT", exitCode: 7 });
    await expect(
      runner.execute({ input, sql: "SELECT 1", memoryLimit: "unlimited" }),
    ).rejects.toMatchObject({ code: "QUERY_MEMORY_LIMIT", exitCode: 7 });
    await expect(
      runner.execute({ input, sql: "SELECT 1", memoryLimit: "1GiB" }),
    ).rejects.toMatchObject({ code: "QUERY_MEMORY_LIMIT", exitCode: 7 });
    expect(directoriesCreated).toBe(1);
  });

  it.each([
    ["rowLimit", 0],
    ["rowLimit", 1_000_001],
    ["timeoutMs", 0],
    ["timeoutMs", 600_001],
    ["maxColumns", 0],
    ["maxCellBytes", -1],
    ["maxOutputBytes", Number.MAX_SAFE_INTEGER],
    ["threads", 5],
  ] as const)("rejects invalid public SDK limit %s=%s before staging", async (key, value) => {
    let staged = false;
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
      stage: async () => {
        staged = true;
        throw new Error("must not stage");
      },
    });
    await expect(runner.execute({ input, sql: "SELECT 1", [key]: value })).rejects.toMatchObject({
      code: "QUERY_LIMIT_INVALID",
      exitCode: 7,
    });
    expect(staged).toBe(false);
  });

  it("caps columns, cells, and total serialized output", async () => {
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    await expect(
      runner.execute({ input, sql: "SELECT repeat('x', 100) AS huge FROM data", maxCellBytes: 16 }),
    ).rejects.toMatchObject({ code: "QUERY_CELL_LIMIT", exitCode: 7 });
    await expect(
      runner.execute({ input, sql: "SELECT * FROM data", maxColumns: 1 }),
    ).rejects.toMatchObject({ code: "QUERY_COLUMN_LIMIT", exitCode: 7 });
    await expect(
      runner.execute({ input, sql: "SELECT * FROM data", maxOutputBytes: 20 }),
    ).rejects.toMatchObject({ code: "QUERY_OUTPUT_LIMIT", exitCode: 7 });
  });

  it("delivers results larger than one IPC write before the worker disconnects", async () => {
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    const result = await runner.execute({
      input,
      sql: "SELECT repeat('x', 100) AS s FROM range(5000)",
      rowLimit: 5_000,
    });
    expect(result.returnedCount).toBe(5_000);
    expect(result.truncated).toBe(false);
  });

  it("does not modify the trusted input", async () => {
    const beforeBytes = await readFile(input);
    const before = await stat(input);
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    await runner.execute({ input, sql: "SELECT count(*) AS count FROM data" });
    expect(await readFile(input)).toEqual(beforeBytes);
    expect((await stat(input)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps the imported database byte-for-byte stable in read-only execution", async () => {
    const databasePath = join(directory, "stable.duckdb");
    const stage = await stageTabularInput({
      input,
      databasePath,
      xlsxRowsPath: join(directory, "xlsx.ndjson"),
      xlsxSharedStringsByteLimit: 1024 * 1024,
      preserveDatabaseOnClose: true,
    });
    await stage.connection.run("CHECKPOINT");
    await stage.close();
    const before = await readFile(databasePath);
    const beforeStat = await stat(databasePath);
    await executeQueryWorker({
      databasePath,
      invocationDirectory: directory,
      sql: "SELECT count(*) FROM data",
      limits: {
        rowLimit: 10,
        timeoutMs: 1_000,
        maxSqlBytes: 1024,
        maxColumns: 10,
        maxCellBytes: 1024,
        maxOutputBytes: 1024,
        memoryLimit: "128MB",
        threads: 1,
      },
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect((await stat(databasePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("reuses a prepared database without modifying it", async () => {
    const databasePath = join(directory, "prepared.duckdb");
    const stage = await stageTabularInput({
      input,
      databasePath,
      xlsxRowsPath: join(directory, "prepared-xlsx.ndjson"),
      xlsxSharedStringsByteLimit: 1024 * 1024,
      preserveDatabaseOnClose: true,
    });
    await stage.connection.run("CHECKPOINT");
    await stage.close();
    await expect(verifyStagedDatabase(databasePath)).resolves.toBeUndefined();
    const before = await readFile(databasePath);
    const beforeStat = await stat(databasePath);
    const runner = new DuckDbQueryRunner({
      workerPath: new URL("./fixtures/query-worker-source-entry.ts", import.meta.url),
    });
    const options = {
      databasePath,
      invocationDirectory: directory,
      sql: "SELECT * FROM data ORDER BY value",
      memoryLimit: "128MB",
      threads: 1,
    } as const;
    const first = await runner.executePrepared(options);
    const second = await runner.executePrepared(options);
    expect(second).toEqual(first);
    expect(await readFile(databasePath)).toEqual(before);
    expect((await stat(databasePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("rejects a prepared database without the expected data table", async () => {
    const databasePath = join(directory, "invalid.duckdb");
    const database = await DuckDBInstance.create(databasePath);
    database.closeSync();
    await expect(verifyStagedDatabase(databasePath)).rejects.toMatchObject({
      code: "STAGED_DATABASE_INVALID",
      exitCode: 7,
    });
  });

  it("removes database, WAL, and spill trees on every completed child path", async () => {
    const run = async (
      workerPath: URL,
      operation: (runner: DuckDbQueryRunner) => Promise<unknown>,
    ) => {
      const created: string[] = [];
      const runner = new DuckDbQueryRunner({
        workerPath,
        graceMs: 50,
        makeTemporaryDirectory: async () => {
          const path = await mkdtemp(join(tmpdir(), "klopsi-query-cleanup-"));
          created.push(path);
          return path;
        },
      });
      await operation(runner);
      expect(created.length).toBeGreaterThan(0);
      for (const path of created)
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    };
    const worker = new URL("./fixtures/query-worker-source-entry.ts", import.meta.url);
    await run(worker, (runner) => runner.execute({ input, sql: "SELECT 1" }));
    await run(worker, (runner) =>
      runner.execute({ input, sql: "PRAGMA version" }).catch(() => undefined),
    );
    await run(worker, (runner) =>
      runner
        .execute({ input, sql: "SELECT * FROM read_csv('/etc/passwd')" })
        .catch(() => undefined),
    );
    await run(worker, (runner) =>
      runner
        .execute({
          input,
          sql: "SELECT sum(a.i * b.i) FROM range(1000000000) a(i), range(1000000000) b(i)",
          timeoutMs: 50,
        })
        .catch(() => undefined),
    );
    await run(new URL("./fixtures/hanging-query-worker.mjs", import.meta.url), (runner) =>
      runner.execute({ input, sql: "SELECT 1", timeoutMs: 50 }).catch(() => undefined),
    );
  });
});
