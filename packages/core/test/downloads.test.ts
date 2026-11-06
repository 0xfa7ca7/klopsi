import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { lstat, readFile, readdir } from "node:fs/promises";
import { ContentCache } from "@klopsi/storage";
import {
  datasetId,
  providerId,
  resourceId,
  type DataProvider,
  type Resource,
} from "@klopsi/domain";
import { describe, expect, it, vi } from "vitest";
import { dirname } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadService, ProviderRegistry } from "../src/index.js";

const resource: Resource = {
  id: resourceId("r"),
  datasetId: datasetId("d"),
  providerId: providerId("p"),
  title: "r",
  url: "https://example.test/file",
};
async function service(filename: string, offline = false) {
  const provider: DataProvider = {
    descriptor: { id: providerId("p"), name: "p", capabilities: [] },
    search: vi.fn(),
    getDataset: vi.fn(),
    getResource: vi.fn(async () => resource),
    listDatasetResources: vi.fn(),
    resolveResource: vi.fn(async () => ({ resource, kind: "file", url: resource.url, filename })),
  };
  const download = vi.fn(async (input: { destination: string }) => {
    await mkdir(dirname(input.destination), { recursive: true });
    await writeFile(input.destination, "x");
    return {
      path: input.destination,
      finalUrl: resource.url,
      redirectChain: [resource.url],
      bytes: 1,
      sha256: "a".repeat(64),
    };
  });
  const probe = vi.fn();
  const provenance = {
    write: vi.fn(async (_artifact, _input, options: { sidecarPath: string }) => {
      await writeFile(options.sidecarPath, "{}\n");
      return options.sidecarPath;
    }),
  };
  const downloadDir = await mkdtemp(join(tmpdir(), "klopsi-core-downloads-"));
  return {
    service: new DownloadService({
      registry: new ProviderRegistry([provider]),
      providerId: "p",
      downloader: { download, probe } as never,
      provenance: provenance as never,
      downloadDir,
      limits: { maxBytes: 10, timeoutMs: 100 },
      offline,
    }),
    download,
    probe,
    downloadDir,
  };
}

async function cachedService(offline: boolean, content = "cached", maxBytes = 5) {
  const downloadDir = await mkdtemp(join(tmpdir(), "klopsi-cached-download-limit-"));
  const cache = new ContentCache(join(downloadDir, "cache"));
  const object = await cache.putObject(Readable.from([content]));
  await cache.putMetadata(
    "download:p:r",
    "download-v1",
    {
      sha256: object.sha256,
      bytes: object.bytes,
      finalUrl: resource.url,
      redirectChain: [resource.url],
      mediaType: "text/plain",
      etag: '"cached"',
      lastModified: "Sat, 11 Jul 2026 10:00:00 GMT",
      retrievalSource: resource.url,
    },
    object.sha256,
    undefined,
    { etag: '"cached"', lastModified: "Sat, 11 Jul 2026 10:00:00 GMT", source: resource.url },
  );
  const provider: DataProvider = {
    descriptor: { id: providerId("p"), name: "p", capabilities: [] },
    search: vi.fn(),
    getDataset: vi.fn(async () => {
      throw new Error("not needed");
    }),
    getResource: vi.fn(async () => resource),
    listDatasetResources: vi.fn(),
    resolveResource: vi.fn(async () => ({ resource, kind: "file", url: resource.url })),
  };
  const probe = vi.fn(async () => ({
    finalUrl: resource.url,
    redirectChain: [resource.url],
    status: 304,
    headers: {},
  }));
  const download = vi.fn();
  const provenance = {
    write: vi.fn(async (_artifact, _input, options: { sidecarPath: string }) => {
      await writeFile(options.sidecarPath, "{}\n");
      return options.sidecarPath;
    }),
  };
  return {
    service: new DownloadService({
      registry: new ProviderRegistry([provider]),
      providerId: "p",
      downloader: { probe, download } as never,
      provenance: provenance as never,
      cache,
      downloadDir,
      limits: { maxBytes, timeoutMs: 100 },
      offline,
    }),
    destination: join(downloadDir, "result.txt"),
    cache,
    object,
    provenance,
    downloadDir,
    download,
    probe,
  };
}

describe("DownloadService containment", () => {
  it.each(["../../escape", "/absolute/escape", "..\\..\\escape", "", "CON"])(
    "sanitizes provider filename %j and fallback",
    async (filename) => {
      const fixture = await service(filename);
      await fixture.service.resource(resource.id);
      const target = (fixture.download.mock.calls[0]?.[0] as { destination: string }).destination;
      expect(target.startsWith(`${fixture.downloadDir}/`)).toBe(true);
      expect(target.slice(`${fixture.downloadDir}/`.length)).not.toMatch(/[\\/]/u);
    },
  );
  it("rejects offline headers before probing", async () => {
    const fixture = await service("file", true);
    await expect(fixture.service.headers(resource.id)).rejects.toMatchObject({
      code: "OFFLINE_CACHE_MISS",
    });
    expect(fixture.probe).not.toHaveBeenCalled();
  });
});

it("uses cached validators for a conditional request and reuses a 304 object", async () => {
  const downloadDir = await mkdtemp(join(tmpdir(), "klopsi-conditional-download-"));
  const cache = new ContentCache(join(downloadDir, "cache"));
  const object = await cache.putObject(Readable.from(["cached"]));
  await cache.putMetadata(
    "download:p:r",
    "download-v1",
    {
      sha256: object.sha256,
      bytes: object.bytes,
      finalUrl: resource.url,
      redirectChain: [resource.url],
      mediaType: "text/plain",
      etag: '"cached"',
      lastModified: "Sat, 11 Jul 2026 10:00:00 GMT",
      retrievalSource: resource.url,
    },
    object.sha256,
    -1,
    { etag: '"cached"', lastModified: "Sat, 11 Jul 2026 10:00:00 GMT", source: resource.url },
  );
  const provider: DataProvider = {
    descriptor: { id: providerId("p"), name: "p", capabilities: [] },
    search: vi.fn(),
    getDataset: vi.fn(async () => {
      throw new Error("not needed");
    }),
    getResource: vi.fn(async () => resource),
    listDatasetResources: vi.fn(),
    resolveResource: vi.fn(async () => ({ resource, kind: "file", url: resource.url })),
  };
  const probe = vi.fn(async () => ({
    finalUrl: resource.url,
    redirectChain: [resource.url],
    status: 304,
    headers: {},
  }));
  const download = vi.fn();
  const provenance = {
    write: vi.fn(async (_artifact, _input, options: { sidecarPath: string }) => {
      await writeFile(options.sidecarPath, "{}\n");
      return options.sidecarPath;
    }),
  };
  const service = new DownloadService({
    registry: new ProviderRegistry([provider]),
    providerId: "p",
    downloader: { probe, download } as never,
    provenance: provenance as never,
    cache,
    downloadDir,
    limits: { maxBytes: 100, timeoutMs: 100 },
  });
  const destination = join(downloadDir, "result.txt");
  await expect(service.resource(resource.id, { destination })).resolves.toMatchObject({
    path: destination,
    sha256: createHash("sha256").update("cached").digest("hex"),
  });
  expect(await readFile(destination, "utf8")).toBe("cached");
  expect(probe).toHaveBeenCalledWith(
    expect.objectContaining({
      headers: {
        "if-none-match": '"cached"',
        "if-modified-since": "Sat, 11 Jul 2026 10:00:00 GMT",
      },
      // The conditional probe must not stack its own retry budget on top of the GET.
      limits: { maxBytes: 100, timeoutMs: 100, retries: 0 },
    }),
  );
  expect(download).not.toHaveBeenCalled();
});

it("rejects an oversized cached object reused after a 304 response", async () => {
  const fixture = await cachedService(false);

  await expect(
    fixture.service.resource(resource.id, { destination: fixture.destination }),
  ).rejects.toMatchObject({
    code: "DOWNLOAD_TOO_LARGE",
    exitCode: 2,
  });
  await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.probe).toHaveBeenCalled();
  expect(fixture.download).not.toHaveBeenCalled();
});

it("rejects an oversized cached object reused offline", async () => {
  const fixture = await cachedService(true);

  await expect(
    fixture.service.resource(resource.id, { destination: fixture.destination }),
  ).rejects.toMatchObject({
    code: "DOWNLOAD_TOO_LARGE",
    exitCode: 2,
  });
  await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.probe).not.toHaveBeenCalled();
  expect(fixture.download).not.toHaveBeenCalled();
});

it("rejects an oversized cached object before a custom materializer can ignore the bound", async () => {
  const fixture = await cachedService(true);
  const materialize = vi
    .spyOn(fixture.cache, "materialize")
    .mockImplementation(async (_digest, destination) => {
      await writeFile(destination, "cached");
      return { ...fixture.object, path: destination };
    });

  await expect(
    fixture.service.resource(resource.id, { destination: fixture.destination }),
  ).rejects.toMatchObject({
    code: "DOWNLOAD_TOO_LARGE",
    exitCode: 2,
  });
  expect(materialize).not.toHaveBeenCalled();
  await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(fixture.downloadDir)).filter((name) => name.includes(".part-"))).toEqual(
    [],
  );
});

it("validates a custom materializer's staged digest before provenance or forced publication", async () => {
  const fixture = await cachedService(true, "safe", 4);
  const sidecar = `${fixture.destination}.provenance.json`;
  await writeFile(fixture.destination, "original");
  await writeFile(sidecar, "original provenance");
  vi.spyOn(fixture.cache, "materialize").mockImplementation(async (_digest, destination) => {
    await writeFile(destination, "evil");
    return { ...fixture.object, path: destination };
  });

  await expect(
    fixture.service.resource(resource.id, { destination: fixture.destination, force: true }),
  ).rejects.toMatchObject({
    code: "CACHE_CORRUPT",
    exitCode: 6,
  });
  expect(fixture.provenance.write).not.toHaveBeenCalled();
  expect(await readFile(fixture.destination, "utf8")).toBe("original");
  expect(await readFile(sidecar, "utf8")).toBe("original provenance");
  expect((await readdir(fixture.downloadDir)).filter((name) => name.includes(".part-"))).toEqual(
    [],
  );
});

it("returns typed pre-tabular guidance for archive resources without downloading", async () => {
  const provider: DataProvider = {
    descriptor: { id: providerId("p"), name: "p", capabilities: [] },
    search: vi.fn(),
    getDataset: vi.fn(),
    getResource: vi.fn(async () => resource),
    listDatasetResources: vi.fn(),
    resolveResource: vi.fn(async () => ({ resource, kind: "archive", url: resource.url })),
  };
  const download = vi.fn();
  const service = new DownloadService({
    registry: new ProviderRegistry([provider]),
    providerId: "p",
    downloader: { download, probe: vi.fn() } as never,
    downloadDir: await mkdtemp(join(tmpdir(), "klopsi-archive-guidance-")),
    limits: { maxBytes: 100, timeoutMs: 100 },
  });
  await expect(service.resource(resource.id, { requireTabular: true })).rejects.toMatchObject({
    code: "DOWNLOAD_ONLY_FORMAT",
    exitCode: 5,
  });
  expect(download).not.toHaveBeenCalled();
});

it("removes the staged download when provenance creation fails before publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klopsi-download-rollback-"));
  const provider: DataProvider = {
    descriptor: { id: providerId("p"), name: "p", capabilities: [] },
    search: vi.fn(),
    getDataset: vi.fn(async () => {
      throw new Error("not needed");
    }),
    getResource: vi.fn(async () => resource),
    listDatasetResources: vi.fn(),
    resolveResource: vi.fn(async () => ({ resource, kind: "file", url: resource.url })),
  };
  const downloader = {
    probe: vi.fn(),
    download: vi.fn(async ({ destination }: { destination: string }) => {
      await writeFile(destination, "x");
      return {
        path: destination,
        finalUrl: resource.url,
        redirectChain: [resource.url],
        bytes: 1,
        sha256: "a".repeat(64),
      };
    }),
  };
  const destination = join(directory, "result.txt");
  const service = new DownloadService({
    registry: new ProviderRegistry([provider]),
    providerId: "p",
    downloader: downloader as never,
    provenance: {
      write: vi.fn(async () => {
        throw new Error("injected provenance failure");
      }),
    } as never,
    downloadDir: directory,
    limits: { maxBytes: 100, timeoutMs: 100 },
  });
  await expect(service.resource(resource.id, { destination })).rejects.toThrow(
    "injected provenance failure",
  );
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(directory)).toEqual([]);
});
