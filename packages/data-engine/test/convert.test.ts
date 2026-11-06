import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { ProvenanceStore } from "@klopsi/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataEngine, writeXlsx, type SupportedDataFormat } from "../src/index.js";

const columns = ["občina", "vrednost", "opomba", "aktivna"] as const;
const rows = [
  { občina: "Škofja Loka", vrednost: 1.5, opomba: null, aktivna: true },
  { občina: "Črnomelj", vrednost: 2, opomba: "živjo", aktivna: false },
] as const;

let root: string;

function path(name: string): string {
  return join(root, name);
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function createInputs(): Promise<Readonly<Record<SupportedDataFormat, string>>> {
  const csv = path("input.csv");
  const tsv = path("input.tsv");
  const json = path("input.json");
  const ndjson = path("input.ndjson");
  const xlsx = path("input.xlsx");
  const parquet = path("input.parquet");
  await writeFile(
    csv,
    `občina,vrednost,opomba,aktivna\nŠkofja Loka,1.5,,true\nČrnomelj,2,živjo,false\n`,
  );
  await writeFile(
    tsv,
    `občina\tvrednost\topomba\taktivna\nŠkofja Loka\t1.5\t\ttrue\nČrnomelj\t2\tživjo\tfalse\n`,
  );
  await writeFile(json, JSON.stringify(rows));
  await writeFile(ndjson, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  await writeXlsx(xlsx, [
    { name: "Data", rows: [columns, ...rows.map((row) => columns.map((column) => row[column]))] },
  ]);

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM read_json_auto('${json.replaceAll("'", "''")}')) TO '${parquet.replaceAll("'", "''")}' (FORMAT PARQUET)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { csv, tsv, json, ndjson, xlsx, parquet };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "klopsi-convert-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("tabular conversion", () => {
  it("converts PC-Axis input to CSV and JSON while preserving long-form rows and warnings", async () => {
    const input = path("tourism.px");
    await writeFile(
      input,
      `AXIS-VERSION="2024";
CODEPAGE="utf-8";
MATRIX="tourism";
STUB="Place";
HEADING="Year";
VALUES("Place")="Ljubljana";
CODES("Place")="001";
VALUES("Year")="2023","2024";
DATA=1 ".";`,
    );
    const engine = new DataEngine();
    const csv = path("tourism.csv");
    const json = path("tourism.json");

    const csvResult = await engine.convert({
      input,
      output: csv,
      targetFormat: "csv",
      force: false,
    });
    const jsonResult = await engine.convert({
      input,
      output: json,
      targetFormat: "json",
      force: false,
    });

    expect(csvResult.warnings).toContainEqual(
      expect.objectContaining({ code: "PCAXIS_DATA_SYMBOL" }),
    );
    expect(jsonResult.warnings).toContainEqual(
      expect.objectContaining({ code: "PCAXIS_DATA_SYMBOL" }),
    );
    await expect(engine.preview(csv)).resolves.toMatchObject({
      rows: [
        { Place: "Ljubljana", Place__code: "001", Year: "2023", value: "1", value__symbol: "" },
        {
          Place: "Ljubljana",
          Place__code: "001",
          Year: "2024",
          value: "",
          value__symbol: ".",
        },
      ],
    });
    await expect(engine.preview(json)).resolves.toMatchObject({
      rows: [
        { Place: "Ljubljana", Place__code: "001", Year: "2023", value: 1, value__symbol: null },
        {
          Place: "Ljubljana",
          Place__code: "001",
          Year: "2024",
          value: null,
          value__symbol: ".",
        },
      ],
    });
  });

  it("preserves case-collision-safe PC-Axis columns through conversion", async () => {
    const input = path("case-collisions.px");
    const output = path("case-collisions.json");
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
    const engine = new DataEngine();

    await engine.convert({ input, output, targetFormat: "json" });

    await expect(engine.preview(output)).resolves.toMatchObject({
      columns: [
        "Region",
        "Region__code",
        "region__2",
        "region__2__code",
        "VALUE__2",
        "VALUE__SYMBOL__2",
        "Region__CODE__2",
        "Region__CODE__2__code",
        "value",
      ],
      rows: [
        {
          Region: "North",
          Region__code: "R1",
          region__2: "South",
          region__2__code: "r1",
          VALUE__2: "Measure",
          VALUE__SYMBOL__2: "Status",
          Region__CODE__2: "Generated collision",
          Region__CODE__2__code: "RC",
          value: 7,
        },
      ],
    });
  });

  it("rejects PC-Axis conversion when DATA has no final semicolon", async () => {
    const input = path("unterminated.px");
    const output = path("unterminated.json");
    await writeFile(
      input,
      `CODEPAGE="utf-8";MATRIX="unterminated";STUB="Row";VALUES("Row")="A","B";DATA=1 2`,
    );

    await expect(
      new DataEngine().convert({ input, output, targetFormat: "json" }),
    ).rejects.toMatchObject({
      code: "INVALID_PCAXIS_DATA",
      exitCode: 6,
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans PC-Axis staging files when conversion fails after staging", async () => {
    const input = path("cleanup.px");
    const output = path("cleanup.json");
    await writeFile(
      input,
      `AXIS-VERSION="2024";CODEPAGE="utf-8";MATRIX="cleanup";STUB="Row";VALUES("Row")="A","B";DATA=1 2;`,
    );
    const engine = new DataEngine({
      onAdapter: (name) => {
        if (name === "convert-json") throw new Error("injected PC-Axis export failure");
      },
    });

    await expect(
      engine.convert({ input, output, targetFormat: "json", force: false }),
    ).rejects.toThrow("injected PC-Axis export failure");
    expect((await readdir(root)).filter((name) => name.startsWith("cleanup.json."))).toEqual([]);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts UTF-16LE tab-separated input declared as CSV", async () => {
    const input = path("budget.csv");
    const output = path("budget.json");
    await writeFile(
      input,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("id\tname\r\n1\tLjubljana\r\n", "utf16le"),
      ]),
    );

    await new DataEngine().convert({ input, output, targetFormat: "json" });

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual([{ id: 1, name: "Ljubljana" }]);
  });

  it("normalizes malformed structured input instead of leaking a DuckDB error", async () => {
    const input = path("broken.json");
    await writeFile(input, "{broken");
    await expect(
      new DataEngine().convert({
        input,
        output: path("out.csv"),
        targetFormat: "csv",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TABULAR_DATA", exitCode: 6 });
  });

  it("converts every input handler to at least two output formats", async () => {
    const inputs = await createInputs();
    const matrix = [
      ["csv", "json"],
      ["csv", "parquet"],
      ["tsv", "json"],
      ["tsv", "xlsx"],
      ["json", "csv"],
      ["json", "parquet"],
      ["json", "ndjson"],
      ["ndjson", "tsv"],
      ["ndjson", "xlsx"],
      ["xlsx", "csv"],
      ["xlsx", "json"],
      ["parquet", "json"],
      ["parquet", "csv"],
    ] as const;
    const engine = new DataEngine();

    for (const [sourceFormat, targetFormat] of matrix) {
      const output = path(`${sourceFormat}-to-${targetFormat}.${targetFormat}`);
      const result = await engine.convert({
        input: inputs[sourceFormat],
        output,
        targetFormat,
        ...(sourceFormat === "xlsx" ? { sheet: "Data" } : {}),
        force: false,
      });

      expect(result).toMatchObject({
        input: inputs[sourceFormat],
        output,
        targetFormat,
        bytesWritten: expect.any(Number),
        provenance: {
          sha256: expect.stringMatching(/^[a-f\d]{64}$/u),
          transformations: [
            expect.objectContaining({
              operation: "convert",
              inputSha256: expect.stringMatching(/^[a-f\d]{64}$/u),
            }),
          ],
        },
      });
      const preview = await engine.preview(output, {
        ...(targetFormat === "xlsx" ? { sheet: "Data" } : {}),
      });
      expect(preview.columns).toEqual(columns);
      expect(preview.rows).toHaveLength(2);
    }
  }, 30_000);

  it("preserves Unicode, column order, nulls, numbers, and booleans through CSV and Parquet", async () => {
    const inputs = await createInputs();
    const engine = new DataEngine();
    const parquet = path("roundtrip.parquet");
    const json = path("roundtrip.json");

    await engine.convert({
      input: inputs.csv,
      output: parquet,
      targetFormat: "parquet",
      force: false,
    });
    await engine.convert({
      input: parquet,
      output: json,
      targetFormat: "json",
      force: false,
    });

    await expect(engine.preview(json)).resolves.toMatchObject({
      columns,
      rows,
    });
  });

  it("preserves the CSV distinction between null and a quoted empty string", async () => {
    const input = path("empty.csv");
    const output = path("empty.json");
    await writeFile(input, 'kind,value\nnull,\nempty,""\n');
    const engine = new DataEngine();

    await engine.convert({ input, output, targetFormat: "json", force: false });

    await expect(engine.preview(output)).resolves.toMatchObject({
      rows: [
        { kind: "null", value: null },
        { kind: "empty", value: "" },
      ],
    });
  });

  it("preserves XLSX nulls and types through CSV by re-importing the delimited result", async () => {
    const inputs = await createInputs();
    const engine = new DataEngine();
    const csv = path("xlsx.csv");
    const json = path("xlsx-roundtrip.json");

    await engine.convert({
      input: inputs.xlsx,
      output: csv,
      targetFormat: "csv",
      sheet: "Data",
      force: false,
    });
    await engine.convert({ input: csv, output: json, targetFormat: "json", force: false });

    await expect(engine.preview(json)).resolves.toMatchObject({ columns, rows });
  });

  it("accepts a single JSON object as a one-row table", async () => {
    const input = path("single.json");
    const output = path("single-output.json");
    await writeFile(input, JSON.stringify({ občina: "Žužemberk", vrednost: 3 }));
    const engine = new DataEngine();

    await engine.convert({ input, output, targetFormat: "json", force: false });

    await expect(engine.preview(output)).resolves.toMatchObject({
      columns: ["občina", "vrednost"],
      rows: [{ občina: "Žužemberk", vrednost: 3 }],
    });
  });

  it("never overwrites without force and atomically replaces a regular file with force", async () => {
    const inputs = await createInputs();
    const engine = new DataEngine();
    const output = path("existing.json");
    await writeFile(output, "keep me");

    await expect(
      engine.convert({ input: inputs.json, output, targetFormat: "json", force: false }),
    ).rejects.toMatchObject({ code: "CONVERSION_DESTINATION_EXISTS", exitCode: 2 });
    await expect(readFile(output, "utf8")).resolves.toBe("keep me");

    await expect(
      engine.convert({ input: inputs.json, output, targetFormat: "json", force: true }),
    ).resolves.toMatchObject({ output });
    await expect(engine.preview(output)).resolves.toMatchObject({ rows });
  });

  it("cleans all temporary files when an injected export failure occurs", async () => {
    const inputs = await createInputs();
    const engine = new DataEngine({
      onAdapter: (name) => {
        if (name === "convert-json") throw new Error("injected export failure");
      },
    });
    const output = path("failed.json");

    await expect(
      engine.convert({ input: inputs.json, output, targetFormat: "json", force: false }),
    ).rejects.toThrow("injected export failure");
    expect((await readdir(root)).filter((name) => name.startsWith("failed.json."))).toEqual([]);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a typed cleanup failure when stage close rejects after publication", async () => {
    const inputs = await createInputs();
    const output = path("close-failure.json");
    const engine = new DataEngine({
      conversionStageClose: async (close) => {
        await close();
        throw Object.assign(new Error("stage close failed"), { code: "EIO" });
      },
    });

    const error = await engine
      .convert({ input: inputs.json, output, targetFormat: "json", force: false })
      .then(
        () => undefined,
        (candidate: unknown) => candidate,
      );

    expect(error).toMatchObject({
      code: "CONVERSION_CLEANUP_FAILED",
      exitCode: 6,
      context: {
        cleanupFailures: [
          expect.objectContaining({
            phase: "stage-close",
            code: "EIO",
            paths: expect.arrayContaining([
              expect.stringContaining(".duckdb"),
              expect.stringContaining(".ndjson"),
            ]),
          }),
        ],
      },
    });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    await expect(engine.preview(output)).resolves.toMatchObject({ rows });
    await expect(readFile(`${output}.provenance.json`)).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ["one", 1],
    ["multiple", 2],
  ] as const)(
    "reports %s temporary removal cleanup failure without false success",
    async (_name, failureCount) => {
      const inputs = await createInputs();
      const output = path(`rm-${failureCount}.json`);
      const engine = new DataEngine({
        conversionFileSystem: {
          rm: async (candidate, options) => {
            const isOutputTemp = candidate.startsWith(`${output}.part-`);
            const isProvenanceTemp = candidate.startsWith(`${output}.provenance.json.part-`);
            if (isOutputTemp || (failureCount === 2 && isProvenanceTemp))
              throw Object.assign(new Error(`remove failed: ${candidate}`), { code: "ENOSPC" });
            await rm(candidate, options);
          },
        },
      });

      const error = await engine
        .convert({ input: inputs.json, output, targetFormat: "json", force: false })
        .then(
          () => undefined,
          (candidate: unknown) => candidate,
        );

      expect(error).toMatchObject({
        code: "CONVERSION_CLEANUP_FAILED",
        exitCode: 6,
        context: {
          cleanupFailures: expect.arrayContaining([
            expect.objectContaining({ phase: "remove", code: "ENOSPC" }),
          ]),
        },
      });
      expect(
        (error as { context: { cleanupFailures: readonly unknown[] } }).context.cleanupFailures,
      ).toHaveLength(failureCount);
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
      await expect(engine.preview(output)).resolves.toMatchObject({ rows });
      await expect(readFile(`${output}.provenance.json`)).resolves.toBeInstanceOf(Buffer);
    },
  );

  it.each([
    ["first", "output"],
    ["second", "provenance"],
  ] as const)(
    "reports committed %s backup removal failure and retains the %s backup",
    async (_position, failedBackup) => {
      const inputs = await createInputs();
      const output = path(`backup-${failedBackup}.json`);
      await new DataEngine().convert({
        input: inputs.json,
        output,
        targetFormat: "json",
        force: false,
      });
      const originalOutput = await readFile(output);
      const originalProvenance = await readFile(`${output}.provenance.json`);
      const replacement = path(`backup-${failedBackup}-replacement.json`);
      await writeFile(replacement, JSON.stringify([{ changed: failedBackup }]));
      const engine = new DataEngine({
        conversionFileSystem: {
          rm: async (candidate, options) => {
            const outputBackup = candidate.startsWith(`${output}.backup-`);
            const provenanceBackup = candidate.startsWith(`${output}.provenance.json.backup-`);
            if (
              (failedBackup === "output" && outputBackup) ||
              (failedBackup === "provenance" && provenanceBackup)
            )
              throw Object.assign(new Error(`backup remove failed: ${candidate}`), {
                code: "EBUSY",
              });
            await rm(candidate, options);
          },
        },
      });

      const error = await engine
        .convert({ input: replacement, output, targetFormat: "json", force: true })
        .then(
          () => undefined,
          (candidate: unknown) => candidate,
        );

      expect(error).toMatchObject({
        code: "CONVERSION_CLEANUP_FAILED",
        exitCode: 6,
        context: {
          cleanupFailures: [
            expect.objectContaining({
              phase: "backup-remove",
              code: "EBUSY",
              path: expect.stringContaining(".backup-"),
            }),
          ],
        },
      });
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
      const failure = (error as { context: { cleanupFailures: readonly { path: string }[] } })
        .context.cleanupFailures[0] as { path: string };
      await expect(readFile(failure.path)).resolves.toEqual(
        failedBackup === "output" ? originalOutput : originalProvenance,
      );
      expect(
        (await readdir(root)).filter(
          (name) => name.includes(".backup-") && name.startsWith(`backup-${failedBackup}.json`),
        ),
      ).toHaveLength(1);
      await expect(engine.preview(output)).resolves.toMatchObject({
        rows: [{ changed: failedBackup }],
      });
      await expect(new ProvenanceStore().verify(output)).resolves.toMatchObject({ valid: true });
    },
  );

  it("reports committed backup directory sync failure after retaining a valid pair", async () => {
    const inputs = await createInputs();
    const output = path("backup-sync.json");
    await new DataEngine().convert({
      input: inputs.json,
      output,
      targetFormat: "json",
      force: false,
    });
    const replacement = path("backup-sync-replacement.json");
    await writeFile(replacement, JSON.stringify([{ changed: "sync" }]));
    let directorySyncs = 0;
    const engine = new DataEngine({
      conversionFileSystem: {
        open: async (candidate, flags, mode) => {
          if (candidate === root && flags === "r") {
            directorySyncs += 1;
            if (directorySyncs === 4)
              throw Object.assign(new Error("backup directory sync failed"), { code: "EIO" });
          }
          return open(candidate, flags, mode);
        },
      },
    });

    const error = await engine
      .convert({ input: replacement, output, targetFormat: "json", force: true })
      .then(
        () => undefined,
        (candidate: unknown) => candidate,
      );

    expect(error).toMatchObject({
      code: "CONVERSION_CLEANUP_FAILED",
      exitCode: 6,
      context: {
        cleanupFailures: [
          expect.objectContaining({
            phase: "backup-directory-sync",
            code: "EIO",
            paths: expect.arrayContaining([root, expect.stringContaining(".backup-")]),
          }),
        ],
      },
    });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    expect((await readdir(root)).filter((name) => name.includes(".backup-"))).toEqual([]);
    await expect(engine.preview(output)).resolves.toMatchObject({ rows: [{ changed: "sync" }] });
    await expect(new ProvenanceStore().verify(output)).resolves.toMatchObject({ valid: true });
  });

  it("preserves a primary typed error while attaching cleanup failures and paths", async () => {
    const inputs = await createInputs();
    const original = await readFile(inputs.json);
    const engine = new DataEngine({
      conversionFileSystem: {
        rm: async (candidate, options) => {
          if (candidate.includes(".stage-") && candidate.endsWith(".duckdb"))
            throw Object.assign(new Error("database cleanup failed"), { code: "EIO" });
          await rm(candidate, options);
        },
      },
    });

    const error = await engine
      .convert({
        input: inputs.json,
        output: inputs.json,
        targetFormat: "json",
        force: true,
      })
      .then(
        () => undefined,
        (candidate: unknown) => candidate,
      );

    expect(error).toMatchObject({
      code: "CONVERSION_INPUT_OUTPUT_CONFLICT",
      exitCode: 2,
      context: {
        cleanupFailures: [
          expect.objectContaining({
            phase: "remove",
            code: "EIO",
            path: expect.stringContaining(".duckdb"),
          }),
        ],
      },
    });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    await expect(readFile(inputs.json)).resolves.toEqual(original);
    await expect(readFile(`${inputs.json}.provenance.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a forced destination if failure occurs between output and provenance", async () => {
    const inputs = await createInputs();
    const output = path("rollback.json");
    const originalEngine = new DataEngine();
    await originalEngine.convert({
      input: inputs.json,
      output,
      targetFormat: "json",
      force: false,
    });
    const originalOutput = await readFile(output);
    const originalProvenance = await readFile(`${output}.provenance.json`);
    const replacement = path("replacement.json");
    await writeFile(replacement, JSON.stringify([{ changed: true }]));
    const failingEngine = new DataEngine({
      onAdapter: (name) => {
        if (name === "convert-provenance-published")
          throw new Error("injected publication failure");
      },
    });

    await expect(
      failingEngine.convert({
        input: replacement,
        output,
        targetFormat: "json",
        force: true,
      }),
    ).rejects.toThrow("injected publication failure");
    await expect(readFile(output)).resolves.toEqual(originalOutput);
    await expect(readFile(`${output}.provenance.json`)).resolves.toEqual(originalProvenance);
    expect((await readdir(root)).filter((name) => name.startsWith("rollback.json."))).toEqual([
      "rollback.json.provenance.json",
    ]);
  });

  it.each([
    ["first", 1],
    ["second", 2],
  ] as const)(
    "retains actionable backups when the %s forced restore fails",
    async (_position, failingRestore) => {
      const inputs = await createInputs();
      const output = path(`restore-${failingRestore}.json`);
      await new DataEngine().convert({
        input: inputs.json,
        output,
        targetFormat: "json",
        force: false,
      });
      const originalOutput = await readFile(output);
      const originalProvenance = await readFile(`${output}.provenance.json`);
      const replacement = path(`replacement-${failingRestore}.json`);
      await writeFile(replacement, JSON.stringify([{ changed: failingRestore }]));
      let restore = 0;
      const engine = new DataEngine({
        onAdapter: (name) => {
          if (name === "convert-provenance-published") throw new Error("trigger rollback");
        },
        conversionFileSystem: {
          rename: async (source, destination) => {
            if (source.includes(".restore-")) {
              restore += 1;
              if (restore === failingRestore)
                throw Object.assign(new Error(`restore ${failingRestore} failed`), {
                  code: "EIO",
                });
            }
            await rename(source, destination);
          },
        },
      });

      const error = await engine
        .convert({ input: replacement, output, targetFormat: "json", force: true })
        .then(
          () => undefined,
          (candidate: unknown) => candidate,
        );
      expect(error).toMatchObject({
        code: "CONVERSION_ROLLBACK_FAILED",
        exitCode: 6,
        context: {
          output: {
            original: output,
            backup: expect.stringContaining(".backup-"),
            restored: failingRestore !== 1,
          },
          provenance: {
            original: `${output}.provenance.json`,
            backup: expect.stringContaining(".backup-"),
            restored: failingRestore !== 2,
          },
          failures: [
            expect.objectContaining({
              code: "EIO",
              backup: expect.stringContaining(".backup-"),
            }),
          ],
        },
      });
      const context = (error as { context: Record<string, { backup: string }> }).context;
      const outputBackup = context.output?.backup as string;
      const provenanceBackup = context.provenance?.backup as string;
      await expect(readFile(outputBackup)).resolves.toEqual(originalOutput);
      await expect(readFile(provenanceBackup)).resolves.toEqual(originalProvenance);
      if (failingRestore === 1) {
        await expect(readFile(output)).resolves.not.toEqual(originalOutput);
        await expect(readFile(`${output}.provenance.json`)).resolves.toEqual(originalProvenance);
      } else {
        await expect(readFile(output)).resolves.toEqual(originalOutput);
        await expect(readFile(`${output}.provenance.json`)).resolves.not.toEqual(
          originalProvenance,
        );
      }
    },
  );

  it("propagates supported directory sync failures and rolls back publication", async () => {
    const inputs = await createInputs();
    const output = path("sync-failure.json");
    let directoryOpens = 0;
    const engine = new DataEngine({
      conversionFileSystem: {
        open: async (candidate, flags, mode) => {
          if (candidate === root && flags === "r") {
            directoryOpens += 1;
            if (directoryOpens === 1)
              throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
          }
          return open(candidate, flags, mode);
        },
      },
    });

    await expect(
      engine.convert({ input: inputs.json, output, targetFormat: "json", force: false }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${output}.provenance.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hashes both sides of the derivation before publishing provenance", async () => {
    const inputs = await createInputs();
    const engine = new DataEngine();
    const output = path("derived.parquet");

    const result = await engine.convert({
      input: inputs.json,
      output,
      targetFormat: "parquet",
      force: false,
    });
    const inputBytes = await readFile(inputs.json);
    const outputBytes = await readFile(output);
    const sidecar = JSON.parse(await readFile(`${output}.provenance.json`, "utf8")) as {
      sha256: string;
      transformations: readonly { inputSha256?: string }[];
    };

    expect(sidecar.sha256).toBe(sha256(outputBytes));
    expect(sidecar.transformations[0]?.inputSha256).toBe(sha256(inputBytes));
    expect(result.provenance).toMatchObject(sidecar);
  });

  it("records spreadsheet-safe transformations while default mode only warns", async () => {
    const input = path("formula.json");
    await writeFile(
      input,
      JSON.stringify([
        { label: "=2+2", command: "+cmd" },
        { label: "safe", command: "safe" },
      ]),
    );
    const engine = new DataEngine();
    const unsafe = path("unsafe.csv");
    const safe = path("safe.csv");

    const defaultResult = await engine.convert({
      input,
      output: unsafe,
      targetFormat: "csv",
      force: false,
    });
    const safeResult = await engine.convert({
      input,
      output: safe,
      targetFormat: "csv",
      force: false,
      spreadsheetSafe: true,
    });

    expect(defaultResult.warnings).toContainEqual(
      expect.objectContaining({ code: "FORMULA_LIKE_VALUE" }),
    );
    expect(await readFile(unsafe, "utf8")).toContain("=2+2");
    expect(await readFile(safe, "utf8")).toContain("'=2+2");
    expect(safeResult.provenance.transformations[0]?.details).toMatchObject({
      spreadsheetSafe: true,
      spreadsheetSafeChanges: 2,
    });
  });
});
