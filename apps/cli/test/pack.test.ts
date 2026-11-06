import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
let root: string;
let omittedRoot: string | undefined;
let tarball: string;
let files: Array<{ path: string; mode: number }>;
let packDestination: string;

const EXPECTED_FILES = [
  "LICENSE",
  "README.md",
  "dist/main.d.ts",
  "dist/main.js",
  "dist/main.js.map",
  "dist/query-worker.d.ts",
  "dist/query-worker.js",
  "dist/query-worker.js.map",
  "dist/sdk.d.ts",
  "dist/sdk.js",
  "dist/sdk.js.map",
  "package.json",
] as const;

const PUBLIC_DECLARATION_FILES = [
  "dist/main.d.ts",
  "dist/query-worker.d.ts",
  "dist/sdk.d.ts",
] as const;

async function tarText(path: string): Promise<string> {
  return (
    await execute("tar", ["-xOf", tarball, `package/${path}`], {
      maxBuffer: 30 * 1024 * 1024,
    })
  ).stdout;
}

async function compileSdkConsumer(directory: string): Promise<void> {
  await writeFile(
    join(directory, "consumer.ts"),
    `import {
  KlopsiClient,
  ProviderRegistry,
  type CanonicalReference,
  type ColumnProfile,
  type Dataset,
  type DatasetId,
  type DuckDbCachePolicy,
  type DataPreview,
  type DownloadRecord,
  type Field,
  type KlopsiClientOptions,
  type NextAction,
  type ParsedCanonicalReference,
  type PcAxisLimits,
  type ProfileServiceOptions,
  type ProfileServiceResult,
  type ProviderId,
  type Provenance,
  type QueryResult,
  type QueryCacheMetadata,
  type QueryCacheWarning,
  type QueryDatabaseWarning,
  type ResourceId,
  type ResourceAccessDescriptor,
  type SearchQuery,
  type ValidationIssue,
  type ValidationResult,
} from 'klopsi/sdk';

const providerId = 'opsi' as ProviderId;
const datasetId = 'traffic' as DatasetId;
const resourceId = 'traffic-csv' as ResourceId;
const reference = 'opsi:resource:traffic-csv' as CanonicalReference;
const nextAction: NextAction = { action: 'resource.preview', argv: ['resource', 'preview', reference] };
const access: ResourceAccessDescriptor = {
  input: reference,
  kind: 'file',
  operations: ['inspect', 'preview'],
  limitations: [],
  nextActions: [nextAction],
};
const field: Field = { name: 'count', type: 'integer', nullable: false, description: 'Vehicles' };
const issue: ValidationIssue = {
  code: 'MISSING_VALUE',
  message: 'A value is missing.',
  severity: 'warning',
  row: 2,
  field: field.name,
  context: { expected: field.type },
};
const validation: ValidationResult = {
  valid: true,
  errors: [],
  warnings: [issue],
  recommendations: [],
  schema: { fields: [field], rowCount: 1 },
};
const provenance: Provenance = {
  schemaVersion: '1',
  providerId,
  datasetId,
  resourceId,
  retrievedAt: '2026-01-01T00:00:00.000Z',
  sha256: 'a'.repeat(64),
  localPath: '/tmp/traffic.csv',
  transformations: [{ operation: 'download', timestamp: '2026-01-01T00:00:00.000Z' }],
};
const download: DownloadRecord = {
  file: { path: provenance.localPath, sha256: provenance.sha256, sizeBytes: 42, source: reference },
  source: reference,
  downloadedAt: provenance.retrievedAt,
  provenance,
};
const queryResult: QueryResult = {
  sql: 'select count from data',
  columns: [field.name],
  rows: [{ count: 42 }],
  returnedCount: 1,
  durationMs: 2,
  truncated: false,
  source: reference,
  provenance,
};
const queryCache: QueryCacheMetadata = { status: 'hit', kind: 'duckdb-stage' };
const queryWarning: QueryCacheWarning = {
  code: 'QUERY_CACHE_BYPASS',
  message: 'temporary staging',
};
const queryDataWarning: QueryDatabaseWarning = {
  code: 'PCAXIS_DATA_SYMBOL',
  severity: 'warning',
  message: 'A PC-Axis data symbol was preserved.',
  recommendation: 'Review the source symbol.',
  context: { symbol: '.', occurrences: 1 },
};
const duckdbCache: DuckDbCachePolicy = { enabled: true, maxBytes: 10_000, ttlMs: 86_400_000 };
const pcAxisLimits: PcAxisLimits = {
  maxSourceBytes: 512_000_000,
  maxMetadataBytes: 16_000_000,
  maxMetadataStatements: 100_000,
  maxStatementBytes: 4_000_000,
  maxDimensions: 64,
  maxValuesPerDimension: 1_000_000,
  maxCells: 100_000_000,
  maxDecodedStringBytes: 1_000_000,
  maxNotes: 10_000,
  maxLanguageVariants: 10_000,
  maxCellTokenBytes: 64_000,
  maxEmittedRecords: 1_000_000,
  maxStagingBytes: 1_000_000_000,
};
const pcAxisPreview: DataPreview = {
  format: 'pcaxis',
  columns: ['Municipality', 'Municipality__code', 'value'],
  codeColumns: ['Municipality__code'],
  rows: [{ Municipality: 'Ljubljana', Municipality__code: '061', value: 42 }],
  returnedCount: 1,
  truncated: false,
  warnings: [],
  encoding: 'utf-8',
  delimiter: ',',
};
const dataset: Dataset = {
  id: datasetId,
  providerId,
  title: 'Traffic',
  providerMetadata: { raw: { source: 'catalog' } },
  resources: [{
    id: resourceId,
    datasetId,
    providerId,
    title: 'CSV',
    url: 'https://example.invalid/traffic.csv',
    providerMetadata: { raw: { table: 'traffic' } },
  }],
};
const parsed: ParsedCanonicalReference = { providerId, kind: 'resource', id: resourceId };
if (parsed.kind === 'resource') parsed.id.toUpperCase();

const registry = new ProviderRegistry([]);
const clientOptions: KlopsiClientOptions = {
  registry,
  providerId,
  duckdbCache,
  pcAxisLimits,
  downloads: { downloadDir: '/tmp', limits: { maxBytes: 1_000, timeoutMs: 1_000 } },
};
const client: KlopsiClient = new KlopsiClient({
  ...clientOptions,
});
const search: SearchQuery = { text: 'promet', filters: { formats: ['csv'] } };
const operations = [
  client.search(search).then((page) => page.items[0]?.providerMetadata?.raw),
  client.datasets.get(datasetId).then((item) => item.resources[0]?.providerMetadata?.raw),
  client.datasets.resources(datasetId).then((items) => items[0]?.mediaType),
  client.resources.get(resourceId).then((item) => item.providerMetadata?.raw),
  client.providers.list(),
  client.downloads?.resource(resourceId, { destination: '/tmp/traffic.csv' }).then((item) => item.provenancePath),
  client.downloads?.headers(resourceId, { allowPrivateNetwork: false }).then((probe) => probe.headers),
  client.cache?.info().then((info) => info.root),
  client.cache?.list().then((items) => items[0]?.bytes),
  client.cache?.list().then((items) => {
    const format = items.find((item) => item.kind === 'duckdb-stage')?.format;
    return format === 'pcaxis' ? format : undefined;
  }),
  client.cache?.clear(),
  client.cache?.prune().then((result) => result.removed),
  client.cache?.verify().then((result) => result.errors[0]),
  client.data.withResolvedInput('/tmp/traffic.csv', {}, async (source) => typeof source === 'string' ? source : source.path),
  client.data.inspect('/tmp/traffic.csv').then((inspection) => inspection.confidence),
  client.data.preview('/tmp/traffic.csv', { limit: 5 }).then((preview) => preview.warnings[0]?.recommendation),
  client.data.inferSchema('/tmp/traffic.csv', { limit: 5 }).then((schema) => schema.fields[0]?.evidence),
  client.data.validate('/tmp/traffic.csv').then((result) => result.schema?.fields[0]?.nullable),
  client.data.convert('/tmp/traffic.csv', { output: '/tmp/traffic.json', targetFormat: 'json' }).then((result) => result.warnings),
  client.conversions.convert('/tmp/traffic.csv', { output: '/tmp/traffic.tsv', targetFormat: 'tsv' }).then((result) => result.provenancePath),
  client.query.execute('/tmp/traffic.csv', { sql: 'select * from data', limit: 5 }).then((result) => [result.source, result.durationMs, result.cache.status, result.warnings]),
  client.query.profile('/tmp/traffic.csv', { timeoutMs: 1_000 }).then((result: ProfileServiceResult) => [result.columnCount, result.rowCount, result.cache.status]),
];
const columnProfile: ColumnProfile = {
  column: 'count', type: 'BIGINT', count: 1, nullCount: 0, nullPercent: 0, distinctApprox: 1,
  min: '42', max: '42', mean: 42, stddev: null,
};
const profileOptions: ProfileServiceOptions = { sheet: 'Data', allowPrivateNetwork: false };
void [columnProfile.min, profileOptions.sheet];
void [access.kind, dataset.providerMetadata?.raw.source, validation.schema?.fields[0]?.nullable,
  download.provenance.transformations[0]?.operation, queryResult.rows[0]?.count,
  queryCache.status, queryWarning.code, queryDataWarning.code,
  pcAxisPreview.codeColumns?.[0], operations];
`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2024", skipLibCheck: false }, include: ["consumer.ts"] }, null, 2)}\n`,
  );
  try {
    await execute(join(directory, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
      cwd: directory,
    });
  } catch (error) {
    const failure = error as Error & { readonly stdout?: string; readonly stderr?: string };
    throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join("\n"), {
      cause: error,
    });
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "klopsi-pack-"));
  packDestination = process.env.KLOPSI_PACK_DESTINATION ?? root;
  await mkdir(packDestination, { recursive: true });
  const packed = await execute("npm", ["pack", "--json", "--pack-destination", packDestination], {
    cwd: resolve(process.cwd(), "apps/cli"),
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string; mode: number }>;
  }>;
  tarball = join(packDestination, result[0]?.filename ?? "missing.tgz");
  files = result[0]?.files ?? [];
  if (process.env.KLOPSI_PACK_DESTINATION !== undefined)
    await writeFile(join(packDestination, "pack.json"), `${JSON.stringify(result, null, 2)}\n`);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (omittedRoot !== undefined) await rm(omittedRoot, { recursive: true, force: true });
});

describe("canonical npm tarball", () => {
  it("contains only the public runtime, SDK, and package documentation", async () => {
    const paths = files.map((file) => file.path).sort();
    expect(
      paths.filter(
        (path) =>
          path.endsWith(".d.ts") &&
          !PUBLIC_DECLARATION_FILES.some((publicPath) => path === publicPath),
      ),
    ).toEqual([]);
    expect(paths).toEqual([...EXPECTED_FILES].sort());
    expect(
      paths.filter(
        (path) =>
          /(?:^|\/)(?:latest|index)\.json$/u.test(path) ||
          /(?:^|\/)v1\/snapshots\/[^/]+\.json$/u.test(path) ||
          /(?:^|\/)catalogue-snapshot(?:\/|$)/u.test(path),
      ),
    ).toEqual([]);
    expect(paths.some((path) => /(?:test|fixture|\.tsbuildinfo)/iu.test(path))).toBe(false);
    expect(files.find((file) => file.path === "dist/main.js")?.mode & 0o111).toBeGreaterThan(0);

    const metadata = JSON.parse(await tarText("package.json")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      name: "klopsi",
      license: "MIT",
      engines: { node: ">=24.0.0" },
      repository: { type: "git" },
      dependencies: { skills: "1.5.19" },
    });
    expect(JSON.stringify(metadata)).not.toContain("workspace:");
    expect(await tarText("dist/main.js")).toMatch(/^#!\/usr\/bin\/env node\n/u);
    for (const file of files.filter((entry) => /\.(?:js|d\.ts|map)$/u.test(entry.path))) {
      const unpacked = await tarText(file.path);
      expect(unpacked).not.toMatch(/(?:\/Users\/|[A-Z]:\\|workspace:)/u);
      if (file.path.endsWith(".js")) {
        expect(unpacked).not.toMatch(/(?:from\s*|import\s*\()\s*["']@klopsi\//u);
        expect(unpacked).not.toMatch(/import\.meta\.resolve\(\s*["']@klopsi\//u);
      }
      if (file.path.endsWith(".d.ts"))
        expect(unpacked).not.toMatch(/(?:@klopsi\/|@duckdb\/node-api|from\s+["']zod["'])/u);
      expect(unpacked).not.toMatch(/(?:api[_-]?key|token|secret)\s*[=:]\s*['"][^'"]+/iu);
    }
    const sdkDeclaration = await tarText("dist/sdk.d.ts");
    expect(sdkDeclaration).not.toMatch(
      /readonly (?:data|conversions|query): unknown|type (?:DownloadRecord|Provenance|QueryResult|ValidationIssue|ValidationResult|ParsedCanonicalReference) = Readonly<Record<string, unknown>>/u,
    );
    expect(sdkDeclaration).toContain("readonly downloads?: DownloadService");
    expect(sdkDeclaration).toContain("readonly cache?: CacheService");
    expect(sdkDeclaration).toContain("export interface PcAxisLimits");
    expect(sdkDeclaration).toContain("export interface DataPreview");
    expect(sdkDeclaration).toContain("readonly codeColumns?: readonly string[]");
    expect(sdkDeclaration).toContain("readonly delimiter?: DelimitedDialect");
    expect(sdkDeclaration).toContain('readonly format?: Exclude<SupportedInputFormat, "xml">');
    expect(sdkDeclaration).toContain("readonly pcAxisLimits?: PcAxisLimits");
  });

  it("installs the exact tarball cleanly and smokes CLI, native formats, and SDK", async () => {
    await execute("npm", ["init", "-y"], { cwd: root });
    await execute("npm", ["install", tarball, "typescript@6.0.3"], {
      cwd: root,
      timeout: 120_000,
    });
    const binary = join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "klopsi.cmd" : "klopsi",
    );
    if (process.platform !== "win32") await chmod(binary, 0o755);
    expect((await stat(binary)).isFile()).toBe(true);
    const metadata = JSON.parse(await tarText("package.json")) as { readonly version: string };
    expect((await execute(binary, ["--version"], { cwd: root })).stdout).toBe(
      `${metadata.version}\n`,
    );
    const generatedSkills = join(root, "generated skills");
    const generated = await execute(
      binary,
      ["generate-skills", "--output-dir", generatedSkills, "--json"],
      { cwd: root },
    );
    expect(JSON.parse(generated.stdout)).toMatchObject({ data: { count: 14 } });
    expect(await readFile(join(generatedSkills, "klopsi", "SKILL.md"), "utf8")).toContain(
      "name: klopsi",
    );
    expect(await readFile(join(generatedSkills, "klopsi-analysis", "SKILL.md"), "utf8")).toContain(
      "klopsi query",
    );
    expect(
      await readFile(join(generatedSkills, "klopsi-dataset-workbench", "SKILL.md"), "utf8"),
    ).toContain("klopsi duckdb open");
    expect(
      await readFile(
        join(generatedSkills, "klopsi-shared", "scripts", "verify-dashboard.mjs"),
        "utf8",
      ),
    ).toContain("const MAX_HTML_BYTES = 15 * 1024 * 1024;");
    expect(
      await readFile(
        join(generatedSkills, "klopsi-static-dashboard", "assets", "static-board.html"),
        "utf8",
      ),
    ).toContain("{{PRESENTATION_MANIFEST_JSON}}");
    expect(
      await readFile(
        join(
          generatedSkills,
          "klopsi-interactive-dashboard",
          "assets",
          "interactive-dashboard.html",
        ),
        "utf8",
      ),
    ).toContain("data-klopsi-filter-region");
    const installer = await execute(
      process.execPath,
      ["--input-type=module", "-e", "console.log(import.meta.resolve('skills/bin/cli.mjs'))"],
      { cwd: root },
    );
    expect(installer.stdout).toContain("skills/bin/cli.mjs");
    const setup = await execute(binary, ["agent", "setup", "--dry-run", "--json"], {
      cwd: root,
    });
    expect(JSON.parse(setup.stdout)).toMatchObject({
      data: { installer: "skills@1.5.19", scope: "global", dryRun: true },
    });
    await expect(access(join(root, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "skills-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const datasetListHelp = (await execute(binary, ["dataset", "list", "--help"], { cwd: root }))
      .stdout;
    expect(datasetListHelp).toContain("--refresh");
    expect(datasetListHelp).toContain("--live");
    expect(
      JSON.parse((await execute(binary, ["doctor", "--json", "--offline"], { cwd: root })).stdout),
    ).toMatchObject({ data: { status: "pass" } });
    const csv = resolve(process.cwd(), "packages/testing/fixtures/data/valid.csv");
    const queryEnvironment = {
      ...process.env,
      HOME: root,
      KLOPSI_CACHE_DIR: join(root, "cache"),
    };
    const queryArguments = ["query", csv, "--sql", "select 42 as answer", "--json"];
    const firstQuery = JSON.parse(
      (await execute(binary, queryArguments, { cwd: root, env: queryEnvironment })).stdout,
    );
    const secondQuery = JSON.parse(
      (await execute(binary, queryArguments, { cwd: root, env: queryEnvironment })).stdout,
    );
    expect(firstQuery).toMatchObject({
      data: [{ answer: 42 }],
      meta: { cache: { status: "miss", kind: "duckdb-stage" } },
    });
    expect(secondQuery).toMatchObject({
      data: firstQuery.data,
      meta: { cache: { status: "hit", kind: "duckdb-stage" } },
    });
    const xlsx = resolve(process.cwd(), "packages/testing/fixtures/data/data.xlsx");
    expect(
      JSON.parse(
        (
          await execute(binary, ["resource", "preview", xlsx, "--sheet", "Cities", "--json"], {
            cwd: root,
          })
        ).stdout,
      ).data.length,
    ).toBeGreaterThan(0);
    const sdk = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import('klopsi/sdk').then(m=>{if(!m.KlopsiClient||!m.ProviderRegistry)process.exit(1)})",
      ],
      { cwd: root },
    );
    expect(sdk.stderr).toBe("");
    await compileSdkConsumer(root);
  }, 120_000);

  it("reports a typed failure when optional DuckDB dependencies are omitted", async () => {
    const omitted = await mkdtemp(join(tmpdir(), "klopsi-pack-omitted-"));
    omittedRoot = omitted;
    await execute("npm", ["init", "-y"], { cwd: omitted });
    await execute("npm", ["install", "--omit=optional", tarball, "typescript@6.0.3"], {
      cwd: omitted,
      timeout: 120_000,
    });
    const binary = join(
      omitted,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "klopsi.cmd" : "klopsi",
    );
    let nativeFailure: (Error & { code?: number; stdout?: string }) | undefined;
    try {
      await execute(binary, ["doctor", "--json", "--offline"], { cwd: omitted });
    } catch (error) {
      nativeFailure = error as Error & { code?: number; stdout?: string };
    }
    expect(nativeFailure).toMatchObject({
      code: 5,
      stdout: expect.stringContaining("DUCKDB_UNAVAILABLE"),
    });
    const report = JSON.parse(nativeFailure?.stdout ?? "") as {
      data: { checks: Array<{ name: string; status: string }> };
    };
    expect(report.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "format:csv", status: "pass" }),
        expect.objectContaining({ name: "format:xlsx", status: "pass" }),
        expect.objectContaining({ name: "format:parquet", status: "fail" }),
      ]),
    );
    const csv = resolve(process.cwd(), "packages/testing/fixtures/data/valid.csv");
    let queryFailure: (Error & { code?: number; stdout?: string }) | undefined;
    try {
      await execute(binary, ["query", csv, "--sql", "select * from data", "--json"], {
        cwd: omitted,
      });
    } catch (error) {
      queryFailure = error as Error & { code?: number; stdout?: string };
    }
    expect(queryFailure).toMatchObject({
      code: 5,
      stdout: expect.stringContaining("DUCKDB_UNAVAILABLE"),
    });
    await compileSdkConsumer(omitted);
  }, 120_000);
});
