import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let home: string;
let apiUrl: string;
let fileOrigin: string;
const hits = new Map<string, number>();
let api: ReturnType<typeof createServer>;
let files: ReturnType<typeof createServer>;

const json = (response: ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

/** Each path fails transiently `failures` times (with `Retry-After: 0`) before succeeding. */
const SCENARIOS: Record<string, { failures: number; status?: number }> = {
  "/flaky.txt": { failures: 1 },
  "/flaky-quiet.txt": { failures: 1 },
  "/flaky-headers.txt": { failures: 1 },
  "/down.txt": { failures: Number.POSITIVE_INFINITY },
  "/down-env.txt": { failures: Number.POSITIVE_INFINITY },
  "/down-disabled.txt": { failures: Number.POSITIVE_INFINITY },
  "/missing.txt": { failures: Number.POSITIVE_INFINITY, status: 404 },
  "/reset.txt": { failures: 1, status: 0 },
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "klopsi-download-retry-e2e-"));
  files = createServer((request, response) => {
    const path = request.url ?? "/";
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    const scenario = SCENARIOS[path];
    if (scenario !== undefined && count <= scenario.failures) {
      if (scenario.status === 0) {
        response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
        response.write("PARTIAL-");
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      response.writeHead(scenario.status ?? 503, { "retry-after": "0" });
      response.end("unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.method === "HEAD" ? undefined : "complete");
  });
  files.listen(0, "127.0.0.1");
  await once(files, "listening");
  const fileAddress = files.address();
  if (fileAddress === null || typeof fileAddress === "string") throw new Error("listen failed");
  fileOrigin = `http://127.0.0.1:${fileAddress.port}`;
  api = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname === "/resource_show")
      json(response, {
        success: true,
        result: {
          id,
          package_id: "dataset-retry",
          name: `${id}.txt`,
          url: `${fileOrigin}/${id}.txt`,
          format: "TXT",
        },
      });
    else if (url.pathname === "/package_show")
      json(response, {
        success: true,
        result: { id: "dataset-retry", name: "retry", title: "Retry", resources: [] },
      });
    else response.writeHead(404).end();
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiAddress = api.address();
  if (apiAddress === null || typeof apiAddress === "string") throw new Error("listen failed");
  apiUrl = `http://127.0.0.1:${apiAddress.port}`;
});

beforeEach(() => hits.clear());

afterAll(async () => {
  api.closeAllConnections();
  files.closeAllConnections();
  api.close();
  files.close();
  await Promise.all([once(api, "close"), once(files, "close")]);
  await rm(home, { recursive: true, force: true });
});

async function cli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; json?: unknown }> {
  const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      KLOPSI_CACHE_DIR: join(home, "cache"),
      KLOPSI_DOWNLOAD_DIR: join(home, "downloads"),
      OPSI_BASE_URL: apiUrl,
      KLOPSI_OFFLINE: "0",
      OPSI_REQUEST_INTERVAL_MS: "0",
      NO_COLOR: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => (stdout += value));
  child.stderr.on("data", (value: string) => (stderr += value));
  const [exitCode] = (await once(child, "exit")) as [number];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    parsed = undefined;
  }
  return { exitCode, stdout, stderr, ...(parsed === undefined ? {} : { json: parsed }) };
}

const NETWORK = ["--allow-insecure-http", "--allow-private-network", "--json"] as const;

describe("transient download retries", () => {
  it("retries a transient 503, warns on stderr, and reports attempts in metadata", async () => {
    const target = join(home, "flaky.txt");
    const result = await cli(["download", "flaky", "--resource", "--output", target, ...NETWORK]);
    expect(result).toMatchObject({
      exitCode: 0,
      json: { data: { bytes: 8, path: target }, meta: { attempts: 2 } },
    });
    expect((result.json as { data: Record<string, unknown> }).data).not.toHaveProperty("attempts");
    expect(result.stderr).toMatch(/warning \[DOWNLOAD_RETRY\]: .*HTTP 503.*attempt 2 of 3/u);
    expect(hits.get("/flaky.txt")).toBe(2);
    expect(await readFile(target, "utf8")).toBe("complete");
    await expect(cli(["provenance", "verify", target, "--json"])).resolves.toMatchObject({
      exitCode: 0,
      json: { data: { valid: true } },
    });
  });

  it("suppresses retry warnings with --quiet", async () => {
    const target = join(home, "flaky-quiet.txt");
    const result = await cli([
      "download",
      "flaky-quiet",
      "--resource",
      "--output",
      target,
      "--quiet",
      ...NETWORK,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(hits.get("/flaky-quiet.txt")).toBe(2);
  });

  it("discards a partial body after a mid-transfer reset and publishes only complete bytes", async () => {
    const target = join(home, "reset.txt");
    const result = await cli(["download", "reset", "--resource", "--output", target, ...NETWORK]);
    expect(result).toMatchObject({ exitCode: 0, json: { meta: { attempts: 2 } } });
    expect(await readFile(target, "utf8")).toBe("complete");
    expect((await readdir(home)).filter((name) => name.includes(".part-"))).toEqual([]);
    await expect(cli(["provenance", "verify", target, "--json"])).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("exits 4 with the last error after exhausting attempts", async () => {
    const target = join(home, "down.txt");
    const result = await cli(["download", "down", "--resource", "--output", target, ...NETWORK]);
    expect(result).toMatchObject({
      exitCode: 4,
      json: {
        error: {
          code: "DOWNLOAD_HTTP_ERROR",
          message: "The download returned HTTP 503.",
          context: { status: 503, attempts: 3 },
        },
      },
    });
    expect(hits.get("/down.txt")).toBe(3);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honours --http-retries and KLOPSI_HTTP_RETRIES with CLI precedence", async () => {
    await expect(
      cli(["download", "down-env", "--resource", ...NETWORK], { KLOPSI_HTTP_RETRIES: "1" }),
    ).resolves.toMatchObject({ exitCode: 4 });
    expect(hits.get("/down-env.txt")).toBe(2);
    await expect(
      cli(["download", "down-disabled", "--resource", "--http-retries", "0", ...NETWORK], {
        KLOPSI_HTTP_RETRIES: "5",
      }),
    ).resolves.toMatchObject({ exitCode: 4, stderr: "" });
    expect(hits.get("/down-disabled.txt")).toBe(1);
  });

  it("does not retry a 404", async () => {
    const result = await cli(["download", "missing", "--resource", ...NETWORK]);
    expect(result).toMatchObject({ exitCode: 4, stderr: "" });
    expect(hits.get("/missing.txt")).toBe(1);
  });

  it("retries resource header probes", async () => {
    const result = await cli(["resource", "headers", "flaky-headers", ...NETWORK]);
    expect(result).toMatchObject({
      exitCode: 0,
      json: { data: { status: 200 }, meta: { attempts: 2 } },
    });
    expect(result.stderr).toContain("DOWNLOAD_RETRY");
  });
});
