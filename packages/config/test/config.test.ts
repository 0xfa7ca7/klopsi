import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  loadConfiguration,
  parseStorageBytes,
  resolveConfigPaths,
  type LoadConfigurationOptions,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function fixtureSources(
  sources: {
    readonly user?: unknown;
    readonly project?: unknown;
    readonly env?: NodeJS.ProcessEnv;
    readonly cli?: LoadConfigurationOptions["cli"];
  } = {},
): Promise<LoadConfigurationOptions> {
  const root = await temporaryDirectory("klopsi-config-");
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  const paths = resolveConfigPaths({ cwd, home });

  if (sources.user !== undefined) {
    await mkdir(dirname(paths.userFile), { recursive: true });
    await writeFile(paths.userFile, JSON.stringify(sources.user));
  }
  if (sources.project !== undefined) {
    await writeFile(paths.projectFile, JSON.stringify(sources.project));
  }

  return { cwd, paths, env: sources.env ?? {}, cli: sources.cli ?? {} };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("provides bounded archive and XML defaults and rejects invalid limits", async () => {
    await expect(loadConfiguration(await fixtureSources())).resolves.toMatchObject({
      archive: { maxEntries: 10_000, maxCompressionRatio: 200 },
      xml: { maxDepth: 128, maxRecords: 100_000 },
    });
    await expect(
      loadConfiguration(await fixtureSources({ project: { archive: { maxEntries: 0 } } })),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
    await expect(
      loadConfiguration(await fixtureSources({ project: { xml: { maxDepth: -1 } } })),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
  });
  it("parses nonnegative storage byte sizes exactly", () => {
    expect(parseStorageBytes("0B")).toBe(0);
    expect(parseStorageBytes("10GB")).toBe(10_000_000_000);
    expect(parseStorageBytes("2GiB")).toBe(2_147_483_648);
    expect(parseStorageBytes("-1GB")).toBeUndefined();
    expect(parseStorageBytes("1.5GB")).toBeUndefined();
    expect(parseStorageBytes("10")).toBeUndefined();
    expect(parseStorageBytes("1XB")).toBeUndefined();
    expect(parseStorageBytes("9007199254740992B")).toBeUndefined();
  });

  it("provides and overrides the DuckDB cache policy", async () => {
    await expect(loadConfiguration(await fixtureSources())).resolves.toMatchObject({
      duckdb: { cache: { enabled: true, maxBytes: "10GB", ttlDays: 30 } },
    });

    await expect(
      loadConfiguration(
        await fixtureSources({
          env: {
            KLOPSI_DUCKDB_CACHE_ENABLED: "false",
            KLOPSI_DUCKDB_CACHE_MAX_BYTES: "2GiB",
            KLOPSI_DUCKDB_CACHE_TTL_DAYS: "7",
          },
        }),
      ),
    ).resolves.toMatchObject({
      duckdb: { cache: { enabled: false, maxBytes: "2GiB", ttlDays: 7 } },
    });
  });

  it.each(["-1GB", "1.5GB", "10", "1XB", "9007199254740992B"])(
    "rejects invalid DuckDB cache size %s",
    async (maxBytes) => {
      await expect(
        loadConfiguration(await fixtureSources({ project: { duckdb: { cache: { maxBytes } } } })),
      ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
    },
  );

  it.each(["1GB", "999MB", "953MiB"])("accepts DuckDB memory limit %s", async (memoryLimit) => {
    await expect(
      loadConfiguration(await fixtureSources({ project: { duckdb: { memoryLimit } } })),
    ).resolves.toMatchObject({ duckdb: { memoryLimit } });
  });

  it.each(["1GiB", "1024MiB", "1.001GB", "1.073GB", "100GB", "unlimited", "1XB", ""])(
    "rejects unsafe DuckDB memory limit %s",
    async (memoryLimit) => {
      await expect(
        loadConfiguration(await fixtureSources({ project: { duckdb: { memoryLimit } } })),
      ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
    },
  );
  it("applies CLI over env over project over user over defaults", async () => {
    const config = await loadConfiguration(
      await fixtureSources({
        user: { query: { rowLimit: 10 } },
        project: { query: { rowLimit: 20 } },
        env: { KLOPSI_QUERY_ROW_LIMIT: "30" },
        cli: { queryRowLimit: 40 },
      }),
    );

    expect(config.query.rowLimit).toBe(40);
  });

  it("defaults to two HTTP retries and layers file, env, and CLI values", async () => {
    await expect(loadConfiguration(await fixtureSources())).resolves.toMatchObject({
      http: { retries: 2 },
    });
    const layered = await loadConfiguration(
      await fixtureSources({
        user: { http: { retries: 5 } },
        project: { http: { retries: 4 } },
        env: { KLOPSI_HTTP_RETRIES: "3" },
      }),
    );
    expect(layered.http).toMatchObject({ retries: 3, timeoutMs: 30_000 });
    const disabled = await loadConfiguration(
      await fixtureSources({ env: { KLOPSI_HTTP_RETRIES: "3" }, cli: { httpRetries: 0 } }),
    );
    expect(disabled.http.retries).toBe(0);
    await expect(
      loadConfiguration(await fixtureSources({ env: { KLOPSI_HTTP_RETRIES: "0" } })),
    ).resolves.toMatchObject({ http: { retries: 0 } });
  });

  it("accepts at most ten HTTP retries", async () => {
    await expect(
      loadConfiguration(await fixtureSources({ env: { KLOPSI_HTTP_RETRIES: "10" } })),
    ).resolves.toMatchObject({ http: { retries: 10 } });
  });

  it.each([
    { env: "-1" },
    { env: "1.5" },
    { env: "many" },
    { env: "11" },
    { file: -1 },
    { file: 2.5 },
    { file: 11 },
    { cli: 11 },
  ])("rejects invalid HTTP retry counts %o", async (value) => {
    await expect(
      loadConfiguration(
        await fixtureSources(
          "env" in value
            ? { env: { KLOPSI_HTTP_RETRIES: value.env } }
            : "cli" in value
              ? { cli: { httpRetries: value.cli } }
              : { project: { http: { retries: value.file } } },
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
  });

  it("does not create config directories while resolving paths", async () => {
    const root = await temporaryDirectory("klopsi-paths-");
    const home = join(root, "missing-home");
    const project = join(root, "missing-project");

    const resolved = resolveConfigPaths({ home, cwd: project });

    expect(resolved.userFile).toContain("klopsi.config.json");
    await expect(pathExists(dirname(resolved.userFile))).resolves.toBe(false);
    await expect(pathExists(project)).resolves.toBe(false);
  });

  it("rejects unknown configuration keys with a stable input error", async () => {
    await expect(
      loadConfiguration(
        await fixtureSources({ project: { query: { rowLimit: 10, surprise: true } } }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION", exitCode: 2 });
  });

  it("loads API credentials from the environment without persisting them", async () => {
    const options = await fixtureSources({ env: { OPSI_API_KEY: "environment-only" } });
    const config = await loadConfiguration(options);
    const store = new ConfigStore(options.paths?.userFile ?? "");

    expect(config.apiKey).toBe("environment-only");
    await expect(store.set("apiKey", "must-not-persist")).rejects.toMatchObject({
      code: "SECRET_CONFIGURATION_KEY",
      exitCode: 2,
    });
    await expect(pathExists(options.paths?.userFile ?? "")).resolves.toBe(false);
  });

  it("honors NO_COLOR from the process environment when no environment is injected", async () => {
    const options = await fixtureSources();
    const paths = options.paths;
    if (paths === undefined) throw new Error("fixture paths are required");
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const config = await loadConfiguration({ paths });
      expect(config.terminal.color).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it("stores validated non-secret values and creates the directory only on write", async () => {
    const options = await fixtureSources();
    const userFile = options.paths?.userFile ?? "";
    const store = new ConfigStore(userFile);

    await expect(pathExists(dirname(userFile))).resolves.toBe(false);
    await store.set("query.rowLimit", 321);

    expect(JSON.parse(await readFile(userFile, "utf8"))).toEqual({
      query: { rowLimit: 321 },
    });
  });
});
