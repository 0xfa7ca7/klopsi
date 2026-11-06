import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataEngine, writeXlsx } from "@klopsi/data-engine";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly json?: unknown;
}

let home: string;
let input: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "klopsi-convert-e2e-"));
  home = await realpath(home);
  input = join(home, "input.xlsx");
  await writeXlsx(input, [
    {
      name: "Data",
      rows: [
        ["občina", "vrednost", "opomba"],
        ["Škofja Loka", 1.5, null],
        ["Črnomelj", 2, "živjo"],
      ],
    },
  ]);
});

afterEach(async () => rm(home, { recursive: true, force: true }));

async function cli(argv: readonly string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...argv], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      KLOPSI_CACHE_DIR: join(home, "cache"),
      KLOPSI_DOWNLOAD_DIR: join(home, "downloads"),
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const [exitCode] = (await once(child, "exit")) as [number];
  let json: unknown;
  try {
    json = JSON.parse(stdout) as unknown;
  } catch {
    json = undefined;
  }
  return { exitCode, stdout, stderr, ...(json === undefined ? {} : { json }) };
}

describe("convert CLI", () => {
  it("converts an explicit XLSX sheet to Parquet and renders structured JSON", async () => {
    const output = join(home, "out.parquet");

    await expect(
      cli(["convert", input, "--sheet", "Data", "--to", "parquet", "--output", output, "--json"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      json: {
        data: {
          input,
          output,
          targetFormat: "parquet",
          provenance: {
            transformations: [
              expect.objectContaining({
                operation: "convert",
                details: expect.objectContaining({ sourceFormat: "xlsx", sheet: "Data" }),
              }),
            ],
          },
        },
      },
    });
    await expect(new DataEngine().preview(output)).resolves.toMatchObject({
      columns: ["občina", "vrednost", "opomba"],
      rows: [
        { občina: "Škofja Loka", vrednost: 1.5, opomba: null },
        { občina: "Črnomelj", vrednost: 2, opomba: "živjo" },
      ],
    });
  });

  it("refuses overwrite, replaces with --force, and produces verifiable provenance", async () => {
    const output = "out.csv";
    const args = [
      "convert",
      input,
      "--sheet",
      "Data",
      "--to",
      "csv",
      "--output",
      output,
      "--json",
    ] as const;

    await expect(cli(args)).resolves.toMatchObject({ exitCode: 0 });
    await expect(cli(args)).resolves.toMatchObject({
      exitCode: 2,
      json: { error: { code: "CONVERSION_DESTINATION_EXISTS" } },
    });
    await expect(cli([...args, "--force"])).resolves.toMatchObject({ exitCode: 0 });
    await expect(cli(["provenance", "verify", output, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
      json: { data: { valid: true, sha256: expect.stringMatching(/^[a-f\d]{64}$/u) } },
    });
    await expect(new DataEngine().preview(join(home, output))).resolves.toMatchObject({
      columns: ["občina", "vrednost", "opomba"],
    });
  });

  it.each(["json", "csv"])(
    "treats literal destination %s as a path without changing the renderer",
    async (destination) => {
      const result = await cli([
        "convert",
        input,
        "--sheet",
        "Data",
        "--to",
        "parquet",
        "--output",
        destination,
      ]);
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.json).toBeUndefined();
      expect(result.stdout.split("\n", 1)[0]).toMatch(/^input\s{2,}output\s{2,}targetFormat/u);
      await expect(new DataEngine().preview(join(home, destination))).resolves.toMatchObject({
        format: "parquet",
      });
    },
  );
});
