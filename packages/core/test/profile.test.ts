import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentCache } from "@klopsi/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KlopsiClient } from "../src/client.js";
import { QueryDatabaseCache } from "../src/query-database-cache.js";
import { ProviderRegistry } from "../src/registry.js";

const fixtures = fileURLToPath(new URL("../../testing/fixtures/data/", import.meta.url));
const queryWorkerPath = new URL(
  "../../data-engine/test/fixtures/query-worker-source-entry.ts",
  import.meta.url,
);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "klopsi-core-profile-"));
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

function client(cached = false): KlopsiClient {
  return new KlopsiClient({
    registry: new ProviderRegistry(),
    providerId: "opsi",
    cwd: directory,
    queryWorkerPath,
    ...(cached
      ? {
          cache: new ContentCache(join(directory, "cache")),
          duckdbCache: { enabled: true, maxBytes: 100_000_000, ttlMs: 86_400_000 },
        }
      : {}),
  });
}

describe("QueryService.profile", () => {
  it("profiles a local fixture with source, duration, and cache metadata", async () => {
    const service = client(true).query;
    const input = join(fixtures, "valid.csv");
    const first = await service.profile(input, {});
    expect(first).toMatchObject({
      source: input,
      rowCount: 3,
      columnCount: 3,
      cache: { status: "miss", kind: "duckdb-stage" },
      warnings: [],
      durationMs: expect.any(Number),
    });
    expect(first.columns.map((column) => column.column)).toEqual(["id", "mesto", "aktivno"]);
    const second = await service.profile(input, {});
    expect(second).toMatchObject({ cache: { status: "hit" }, columns: first.columns });
  });

  it("profiles a selected XLSX sheet", async () => {
    const result = await client().query.profile(join(fixtures, "data.xlsx"), { sheet: "Cities" });
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.cache.status).toBe("bypass");
    expect(result.columns.length).toBe(result.columnCount);
  });

  it("rejects unsupported input with the unsupported exit category", async () => {
    const input = join(directory, "image.png");
    await writeFile(input, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    await expect(client().query.profile(input, {})).rejects.toMatchObject({ exitCode: 5 });
  });

  it("applies query bounds to profile statements", async () => {
    await expect(
      client().query.profile(join(fixtures, "valid.csv"), { memoryLimit: "2GB" }),
    ).rejects.toMatchObject({ code: "QUERY_MEMORY_LIMIT", exitCode: 7 });
  });
});

describe("QueryDatabaseCache cancellation", () => {
  it("maps an interrupted staging import to a stable query cancellation", async () => {
    const controller = new AbortController();
    const databases = new QueryDatabaseCache({
      runner: { executePrepared: async () => Promise.reject(new Error("not reached")) },
      stage: async () => {
        controller.abort();
        throw new Error("INTERRUPT Error: Interrupted!");
      },
    });
    await expect(
      databases.profile(join(fixtures, "valid.csv"), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "QUERY_CANCELLED", exitCode: 7 });
  });
});
