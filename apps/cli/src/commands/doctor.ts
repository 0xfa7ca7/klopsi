import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import type { KlopsiClient } from "@klopsi/core";
import {
  DataEngine,
  SUPPORTED_DATA_FORMATS,
  writeXlsx,
  type SupportedDataFormat,
} from "@klopsi/data-engine";
import type { Command } from "commander";
import { manifestCommand } from "../command-manifest.js";
import type { CliContext } from "../context.js";

export interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly message?: string;
}

export interface DoctorReport {
  readonly status: "pass" | "fail";
  readonly checks: readonly DoctorCheck[];
}

function duckDbUnavailable(cause: unknown): KlopsiError {
  return new KlopsiError({
    code: "DUCKDB_UNAVAILABLE",
    message: `DuckDB native bindings are unavailable for ${process.platform}/${process.arch}.`,
    exitCode: EXIT_CODES.UNSUPPORTED,
    suggestion:
      "Install optional dependencies on a supported Node 24 platform (Linux x64 glibc, macOS arm64, or Windows x64), then reinstall klopsi.",
    cause,
  });
}

export async function checkDuckDb(): Promise<Readonly<Record<string, unknown>>> {
  try {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:", {
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      allow_unsigned_extensions: "false",
    });
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll("SELECT 42 AS answer");
      const row = reader.getRowObjects()[0] as { answer?: number | bigint } | undefined;
      return { answer: Number(row?.answer), version: process.versions.node };
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } catch (error) {
    throw duckDbUnavailable(error);
  }
}

async function writable(directory: string): Promise<Readonly<Record<string, unknown>>> {
  const probe = join(directory, `.doctor-${randomUUID()}`);
  const expected = Buffer.from("klopsi-doctor-probe", "utf8");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(probe, expected, { flag: "wx", mode: 0o600 });
    const actual = await readFile(probe);
    if (!actual.equals(expected)) throw new Error("Filesystem probe contents did not round-trip.");
    return { path: directory, bytes: actual.length };
  } finally {
    await rm(probe, { force: true });
  }
}

async function createBasicFormatFixtures(
  directory: string,
): Promise<Readonly<Record<Exclude<SupportedDataFormat, "parquet">, string>>> {
  const paths = {
    csv: join(directory, "data.csv"),
    tsv: join(directory, "data.tsv"),
    json: join(directory, "data.json"),
    ndjson: join(directory, "data.ndjson"),
    xlsx: join(directory, "data.xlsx"),
  } as const;
  await Promise.all([
    writeFile(paths.csv, "answer\n42\n"),
    writeFile(paths.tsv, "answer\tlabel\n42\tok\n"),
    writeFile(paths.json, '[{"answer":42}]\n'),
    writeFile(paths.ndjson, '{"answer":42}\n'),
  ]);
  await writeXlsx(paths.xlsx, [{ name: "Data", rows: [["answer"], [42]] }]);
  return paths;
}

async function createParquetFixture(path: string): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:", {
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    allow_unsigned_extensions: "false",
  });
  const connection = await instance.connect();
  try {
    const literal = `'${path.replaceAll("'", "''")}'`;
    await connection.run(`COPY (SELECT 42 AS answer) TO ${literal} (FORMAT PARQUET)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function createPcAxisFixture(path: string): Promise<void> {
  await writeFile(
    path,
    `CHARSET="ANSI";
AXIS-VERSION="2010";
CODEPAGE="utf-8";
MATRIX="doctor";
STUB="Municipality";
HEADING="Year";
VALUES("Municipality")="Ljubljana";
CODES("Municipality")="061";
VALUES("Year")="2024","2025";
CODES("Year")="24","25";
DATASYMBOLNIL="Missing";
DATA=
42 "-";`,
  );
}

async function capture(
  checks: DoctorCheck[],
  name: string,
  operation: () => Promise<Readonly<Record<string, unknown>>>,
): Promise<void> {
  try {
    checks.push({ name, status: "pass", detail: await operation() });
  } catch (error) {
    checks.push({
      name,
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof KlopsiError ? { detail: { code: error.code } } : {}),
    });
  }
}

export async function runDoctorChecks(
  context: CliContext,
  client: KlopsiClient,
  offline: boolean,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 24 ? "pass" : "fail",
    detail: { version: process.versions.node, platform: process.platform, arch: process.arch },
  });
  checks.push({
    name: "configuration",
    status: context.configuration === undefined ? "fail" : "pass",
    ...(context.configuration === undefined ? { message: "Configuration was not loaded." } : {}),
  });
  await capture(checks, "cache", () =>
    writable(context.configuration?.paths.cacheDir ?? join(tmpdir(), "klopsi-cache")),
  );
  await capture(checks, "temp", () => writable(tmpdir()));
  if (offline || context.configuration?.provider === "local")
    checks.push({
      name: "connectivity",
      status: "skip",
      detail: { reason: offline ? "offline" : "local-provider" },
    });
  else
    await capture(checks, "connectivity", async () => {
      const page = await client.search({ limit: 1 });
      return {
        provider: context.configuration?.provider ?? "opsi",
        resultCount: page.items.length,
      };
    });
  await capture(checks, "duckdb", checkDuckDb);

  const directory = await mkdtemp(join(tmpdir(), "klopsi-doctor-formats-"));
  try {
    const engine = new DataEngine();
    let fixtures: Readonly<Record<Exclude<SupportedDataFormat, "parquet">, string>> | undefined;
    await capture(checks, "format-fixtures", async () => {
      fixtures = await createBasicFormatFixtures(directory);
      return { created: true };
    });
    for (const format of SUPPORTED_DATA_FORMATS.filter((value) => value !== "parquet"))
      await capture(checks, `format:${format}`, async () => {
        if (fixtures === undefined) throw new Error("Basic format fixtures are unavailable.");
        const preview = await engine.preview(fixtures[format], {
          limit: 1,
          ...(format === "xlsx" ? { sheet: "Data" } : {}),
        });
        if (preview.rows.length !== 1) throw new Error(`${format} handler returned no rows.`);
        return { format, rows: preview.rows.length, columns: preview.columns.length };
      });
    await capture(checks, "format:parquet", async () => {
      const path = join(directory, "data.parquet");
      await createParquetFixture(path);
      const preview = await engine.preview(path, { limit: 1 });
      if (preview.rows.length !== 1) throw new Error("parquet handler returned no rows.");
      return { format: "parquet", rows: preview.rows.length };
    });
    await capture(checks, "format:pcaxis", async () => {
      const path = join(directory, "data.px");
      await createPcAxisFixture(path);
      const preview = await engine.preview(path, { limit: 2 });
      if (preview.rows.length !== 2) throw new Error("pcaxis handler returned incomplete rows.");
      const code = preview.rows[0]?.Municipality__code;
      const sourceSymbol = preview.rows[1]?.value__symbol;
      if (code !== "061" || sourceSymbol !== "-")
        throw new Error("pcaxis handler did not preserve codes and source symbols.");
      return {
        format: "pcaxis",
        inputOnly: true,
        rows: preview.rows.length,
        columns: preview.columns.length,
        codeColumns: preview.codeColumns ?? [],
        sourceSymbol,
      };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { status: checks.some((check) => check.status === "fail") ? "fail" : "pass", checks };
}

export function registerDoctorCommand(
  program: Command,
  context: CliContext,
  client: KlopsiClient,
): void {
  manifestCommand(program, "doctor").action(async (options: { offline?: boolean }) => {
    const offline = options.offline === true || context.configuration?.offline === true;
    const report = await runDoctorChecks(context, client, offline);
    handleDoctorReport(context, report);
  });
}

export function handleDoctorReport(context: CliContext, report: DoctorReport): void {
  if (report.status === "pass") {
    context.renderer?.write(report);
    return;
  }
  if (context.configuration?.output === "human") context.renderer?.write(report);
  const nativeFailed = report.checks.some(
    (check) => check.status === "fail" && check.detail?.code === "DUCKDB_UNAVAILABLE",
  );
  const connectivityFailed = report.checks.some(
    (check) => check.name === "connectivity" && check.status === "fail",
  );
  throw new KlopsiError({
    code: nativeFailed ? "DUCKDB_UNAVAILABLE" : "DOCTOR_FAILED",
    message: "One or more diagnostic checks failed.",
    exitCode: nativeFailed
      ? EXIT_CODES.UNSUPPORTED
      : connectivityFailed
        ? EXIT_CODES.PROVIDER_FAILURE
        : EXIT_CODES.INTEGRITY_FAILURE,
    suggestion: "Review every failed check, correct the environment, and run doctor again.",
    context: { data: report },
  });
}
