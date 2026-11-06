import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const fixtures = resolve("packages/testing/fixtures/data");
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "klopsi-profile-e2e-"));
});
afterEach(async () => rm(home, { recursive: true, force: true }));

async function cli(argv: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...argv], {
    cwd: home,
    env: {
      ...process.env,
      ...env,
      HOME: home,
      KLOPSI_CACHE_DIR: join(home, "cache"),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

describe("profile CLI", () => {
  it("returns one statistics row per column with profile metadata", async () => {
    const input = join(fixtures, "valid.csv");
    const first = await cli(["profile", input, "--json"]);
    expect(first).toMatchObject({
      exitCode: 0,
      stderr: "",
      json: {
        data: [
          {
            column: "id",
            type: "BIGINT",
            count: 3,
            nullCount: 0,
            nullPercent: 0,
            distinctApprox: 3,
            min: "1",
            max: "3",
            mean: 2,
            stddev: 1,
          },
          { column: "mesto", type: "VARCHAR", min: "Ljubljana", max: "Škofja Loka", mean: null },
          { column: "aktivno", type: "BOOLEAN" },
        ],
        meta: {
          source: input,
          columnCount: 3,
          rowCount: 3,
          durationMs: expect.any(Number),
          cache: { status: "miss", kind: "duckdb-stage" },
        },
      },
    });
    await expect(cli(["profile", input, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { meta: { cache: { status: "hit" } } },
    });
  });

  it("profiles an XLSX sheet and a selected ZIP entry", async () => {
    await expect(
      cli(["profile", join(fixtures, "data.xlsx"), "--sheet", "Cities", "--json"]),
    ).resolves.toMatchObject({ exitCode: 0, json: { meta: { rowCount: expect.any(Number) } } });
    const archive = join(home, "bundle.zip");
    await writeFile(
      archive,
      zipSync({ "notes.txt": strToU8("notes"), "rows.csv": strToU8("value\n1\n2\n3\n4\n") }),
    );
    await expect(cli(["profile", archive, "--entry", "rows.csv", "--json"])).resolves.toMatchObject(
      {
        exitCode: 0,
        json: { data: [{ column: "value", count: 4, mean: 2.5 }], meta: { columnCount: 1 } },
      },
    );
  });

  it("renders a human table and delimited output", async () => {
    const input = join(fixtures, "data.tsv");
    const table = await cli(["profile", input]);
    expect(table).toMatchObject({ exitCode: 0 });
    expect(table.stdout).toMatch(/column/u);
    expect(table.stdout).toMatch(/mesto/u);
    expect(table.stdout).not.toContain(input);
    expect(table.stderr).toBe(`2 rows, 2 columns, ${input}\n`);
    await expect(cli(["profile", input, "--quiet"])).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    const csv = await cli(["profile", input, "--csv", "--fields", "column,type,count"]);
    expect(csv.stdout).toBe("column,type,count\nid,BIGINT,2\nmesto,VARCHAR,2\n");
    expect(csv.stderr).toBe("");
  });

  it("maps unsupported input to exit 5 and an exhausted deadline to exit 7", async () => {
    const image = join(home, "image.png");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    await expect(cli(["profile", image, "--json"])).resolves.toMatchObject({ exitCode: 5 });
    await expect(
      cli(["profile", join(fixtures, "valid.csv"), "--timeout-ms", "1", "--json"]),
    ).resolves.toMatchObject({ exitCode: 7, json: { error: { code: "QUERY_TIMEOUT" } } });
  });
});
