import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CacheLock,
  DEFAULT_DOWNLOAD_RETRIES,
  Downloader,
  SafeDispatcherFactory,
  parseRetryAfter,
  type DownloadRetryEvent,
} from "@klopsi/storage";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }),
  );
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Step = (request: IncomingMessage, response: ServerResponse) => void;

/** Serves `steps[n]` for the nth request; the last step repeats. */
async function sequence(steps: readonly Step[]): Promise<{ url: string; count: () => number }> {
  let count = 0;
  const server = createServer((request, response) => {
    const step = steps[Math.min(count, steps.length - 1)]!;
    count += 1;
    step(request, response);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  return { url: `http://127.0.0.1:${address.port}/file`, count: () => count };
}

async function destination(name = "file.txt"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "klopsi-download-retry-"));
  roots.push(directory);
  return join(directory, name);
}

async function partFiles(path: string): Promise<string[]> {
  return (await readdir(join(path, ".."))).filter((name) => name.includes(".part-"));
}

const ok =
  (body: string): Step =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  };
const status =
  (code: number, headers: Record<string, string> = {}): Step =>
  (_request, response) => {
    response.writeHead(code, headers);
    response.end("transient");
  };
const reset: Step = (request) => {
  request.socket.destroy();
};

function harness(random = () => 0.5) {
  const sleeps: number[] = [];
  const events: DownloadRetryEvent[] = [];
  const downloader = new Downloader(new SafeDispatcherFactory(), {
    retry: {
      random,
      sleep: async (milliseconds: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw signal.reason;
        sleeps.push(milliseconds);
      },
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    },
    onRetry: (event) => events.push(event),
  });
  return { downloader, sleeps, events };
}

const local = (url: string, path: string, retries?: number, timeoutMs = 2_000) => ({
  url,
  destination: path,
  allowInsecureHttp: true,
  allowPrivateNetwork: true,
  limits: { maxBytes: 1_000, timeoutMs, ...(retries === undefined ? {} : { retries }) },
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("parses delta seconds and HTTP dates", () => {
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("7", now)).toBe(7_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("Thursday, 01-Jan-26 00:00:09 GMT", now)).toBe(9_000);
    expect(parseRetryAfter("Thu Jan  1 00:00:04 2026", now)).toBe(4_000);
  });
  it("ignores missing and malformed values", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-1", now)).toBeUndefined();
    expect(parseRetryAfter(["1", "2"], now)).toBeUndefined();
    for (const lenient of [
      "garbage 99",
      "2026-01-01T00:00:05Z",
      "Thu, 01 Jan 2026 00:00:05",
      "01 Jan 2026 00:00:05 GMT",
      "Thu, 1 Jan 2026 00:00:05 GMT",
      "Thu, 01 Foo 2026 00:00:05 GMT",
      "1.5",
    ])
      expect(parseRetryAfter(lenient, now), lenient).toBeUndefined();
  });
});

describe("Downloader retries", () => {
  it("defaults to three attempts in total", () => {
    expect(DEFAULT_DOWNLOAD_RETRIES).toBe(2);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    "retries HTTP %i and then succeeds",
    async (code) => {
      const server = await sequence([status(code), ok("hello")]);
      const { downloader, events } = harness();
      const path = await destination();
      await expect(downloader.download(local(server.url, path))).resolves.toMatchObject({
        bytes: 5,
        attempts: 2,
      });
      expect(server.count()).toBe(2);
      expect(await readFile(path, "utf8")).toBe("hello");
      expect(events).toEqual([
        expect.objectContaining({ attempt: 1, maxAttempts: 3, status: code, method: "GET" }),
      ]);
    },
  );

  it("retries connection resets before headers", async () => {
    const server = await sequence([reset, ok("hello")]);
    const { downloader, events } = harness();
    await expect(
      downloader.download(local(server.url, await destination())),
    ).resolves.toMatchObject({ attempts: 2 });
    expect(events[0]?.reason).toMatch(/ECONNRESET|UND_ERR_SOCKET|socket/iu);
  });

  it("discards partial bytes from a reset attempt and never splices artifacts", async () => {
    const partial: Step = (_request, response) => {
      response.writeHead(200, { "content-length": "11" });
      response.write("STALE-");
      setTimeout(() => response.socket?.destroy(), 20);
    };
    const server = await sequence([partial, ok("fresh")]);
    const { downloader } = harness();
    const path = await destination();
    const result = await downloader.download(local(server.url, path));
    expect(await readFile(path, "utf8")).toBe("fresh");
    expect(result).toMatchObject({ bytes: 5, attempts: 2 });
    expect(await partFiles(path)).toEqual([]);
  });

  it("removes partial output when every attempt is reset mid-body", async () => {
    const partial: Step = (_request, response) => {
      response.writeHead(200, { "content-length": "11" });
      response.write("STALE-");
      setTimeout(() => response.socket?.destroy(), 20);
    };
    const server = await sequence([partial]);
    const { downloader } = harness();
    const path = await destination();
    await expect(downloader.download(local(server.url, path))).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      exitCode: 4,
      context: expect.objectContaining({ attempts: 3 }),
    });
    expect(server.count()).toBe(3);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await partFiles(path)).toEqual([]);
  });

  it("exhausts attempts with full-jitter exponential backoff and reports the last error", async () => {
    const server = await sequence([status(503)]);
    const { downloader, sleeps, events } = harness(() => 0.5);
    const path = await destination();
    await expect(downloader.download(local(server.url, path))).rejects.toMatchObject({
      code: "DOWNLOAD_HTTP_ERROR",
      message: "The download returned HTTP 503.",
      exitCode: 4,
      context: { status: 503, attempts: 3 },
    });
    expect(server.count()).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps exponential backoff at the maximum delay", async () => {
    const server = await sequence([status(503)]);
    const sleeps: number[] = [];
    const downloader = new Downloader(new SafeDispatcherFactory(), {
      retry: {
        baseDelayMs: 20_000,
        maxDelayMs: 30_000,
        random: () => 0.999_999,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    });
    await expect(
      downloader.download(local(server.url, await destination(), 3)),
    ).rejects.toMatchObject({ code: "DOWNLOAD_HTTP_ERROR" });
    expect(sleeps).toHaveLength(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
    expect(sleeps[0]).toBeLessThan(20_000);
  });

  it("honours configured retries, including zero", async () => {
    const zero = await sequence([status(503), ok("hello")]);
    await expect(
      harness().downloader.download(local(zero.url, await destination(), 0)),
    ).rejects.toMatchObject({ code: "DOWNLOAD_HTTP_ERROR", context: { attempts: 1 } });
    expect(zero.count()).toBe(1);

    const four = await sequence([status(502), status(502), status(502), status(502), ok("ok")]);
    await expect(
      harness().downloader.download(local(four.url, await destination(), 4)),
    ).resolves.toMatchObject({ attempts: 5 });
  });

  it.each([400, 401, 403, 404, 410])("does not retry HTTP %i", async (code) => {
    const server = await sequence([status(code), ok("hello")]);
    const { downloader, events } = harness();
    await expect(downloader.download(local(server.url, await destination()))).rejects.toMatchObject(
      {
        code: "DOWNLOAD_HTTP_ERROR",
        message: `The download returned HTTP ${code}.`,
        exitCode: 4,
      },
    );
    expect(server.count()).toBe(1);
    expect(events).toEqual([]);
  });

  it("does not retry security-policy or size-limit rejections", async () => {
    const { downloader, events } = harness();
    await expect(
      downloader.download({
        url: "http://insecure.test/file",
        destination: await destination(),
        limits: { maxBytes: 10, timeoutMs: 500 },
      }),
    ).rejects.toMatchObject({ code: "INSECURE_DOWNLOAD_URL" });

    const blocked = new Downloader(
      new SafeDispatcherFactory({ resolver: async () => [{ address: "127.0.0.1", family: 4 }] }),
      { onRetry: (event) => events.push(event) },
    );
    await expect(
      blocked.download({
        url: "https://blocked.test/",
        destination: await destination(),
        limits: { maxBytes: 10, timeoutMs: 500 },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_ADDRESS_FORBIDDEN" });

    const redirect = await sequence([
      (_request, response) => response.writeHead(302, { location: "file:///etc/passwd" }).end(),
    ]);
    await expect(
      downloader.download(local(redirect.url, await destination())),
    ).rejects.toMatchObject({ code: "INSECURE_DOWNLOAD_URL" });
    expect(redirect.count()).toBe(1);

    const large = await sequence([ok("x".repeat(2_000))]);
    await expect(downloader.download(local(large.url, await destination()))).rejects.toMatchObject({
      code: "DOWNLOAD_TOO_LARGE",
    });
    expect(large.count()).toBe(1);
    expect(events).toEqual([]);
  });

  it("never waits less than jittered backoff for a zero, past, or malformed Retry-After", async () => {
    for (const value of ["0", "Wed, 31 Dec 2025 23:00:00 GMT", "garbage 99"]) {
      const server = await sequence([status(503, { "retry-after": value }), ok("hello")]);
      const { downloader, sleeps } = harness(() => 0.5);
      await downloader.download(local(server.url, await destination()));
      expect(sleeps, value).toEqual([250]);
    }
  });

  it("reports the origin that actually failed after a redirect", async () => {
    const target = await sequence([status(503), ok("hello")]);
    const source = await sequence([
      (_request, response) => response.writeHead(302, { location: target.url }).end(),
    ]);
    const { downloader, events } = harness();
    await downloader.download(local(source.url, await destination()));
    expect(events).toEqual([expect.objectContaining({ origin: new URL(target.url).origin })]);
    expect(new URL(target.url).origin).not.toBe(new URL(source.url).origin);
  });

  it("preserves the original stack when annotating the final error", async () => {
    const server = await sequence([status(503)]);
    const error = await harness()
      .downloader.download(local(server.url, await destination()))
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "DOWNLOAD_HTTP_ERROR", context: { attempts: 3 } });
    expect(error.stack).toContain("httpError");
  });

  it("maps a caller abort while waiting for the destination lock to DOWNLOAD_CANCELLED", async () => {
    const path = await destination("locked");
    const lock = await CacheLock.acquire(join(path, ".."), `download:${path}`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      await expect(
        new Downloader().download({
          url: "https://never.test/",
          destination: path,
          signal: controller.signal,
          limits: { maxBytes: 10, timeoutMs: 5_000 },
        }),
      ).rejects.toMatchObject({ code: "DOWNLOAD_CANCELLED", exitCode: 4 });
    } finally {
      await lock.release();
    }
  });

  it("honours Retry-After seconds and HTTP dates", async () => {
    const seconds = await sequence([status(429, { "retry-after": "2" }), ok("hello")]);
    const first = harness();
    await first.downloader.download(local(seconds.url, await destination()));
    expect(first.sleeps).toEqual([2_000]);
    expect(first.events[0]).toMatchObject({ status: 429, delayMs: 2_000 });

    const date = await sequence([
      status(503, { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }),
      ok("hello"),
    ]);
    const second = harness();
    await second.downloader.download(local(date.url, await destination()));
    expect(second.sleeps).toEqual([3_000]);
  });

  it("fails instead of waiting when Retry-After exceeds the maximum delay", async () => {
    const server = await sequence([status(503, { "retry-after": "120" }), ok("hello")]);
    const { downloader, sleeps, events } = harness();
    await expect(downloader.download(local(server.url, await destination()))).rejects.toMatchObject(
      {
        code: "DOWNLOAD_HTTP_ERROR",
        exitCode: 4,
        context: { status: 503, attempts: 1, retryAfterMs: 120_000 },
      },
    );
    expect(server.count()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(events).toEqual([]);
  });

  it("retries a per-attempt timeout", async () => {
    const hang: Step = () => undefined;
    const server = await sequence([hang, ok("hello")]);
    const { downloader, events } = harness();
    await expect(
      downloader.download(local(server.url, await destination(), undefined, 300)),
    ).resolves.toMatchObject({ attempts: 2 });
    expect(events[0]?.reason).toMatch(/timed out/iu);
  });

  it("interrupts a backoff sleep immediately on user abort", async () => {
    const server = await sequence([status(503, { "retry-after": "20" }), ok("hello")]);
    const controller = new AbortController();
    const downloader = new Downloader(new SafeDispatcherFactory(), {
      onRetry: () => setTimeout(() => controller.abort(), 10),
    });
    const path = await destination();
    const started = Date.now();
    await expect(
      downloader.download({ ...local(server.url, path), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_CANCELLED" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.count()).toBe(1);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await partFiles(path)).toEqual([]);
  });

  it("does not retry after a user abort during a request", async () => {
    const controller = new AbortController();
    const server = await sequence([
      () => {
        controller.abort();
      },
      ok("hello"),
    ]);
    const { downloader, events } = harness();
    await expect(
      downloader.download({ ...local(server.url, await destination()), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_CANCELLED" });
    expect(server.count()).toBe(1);
    expect(events).toEqual([]);
  });

  it("retries probes on transient statuses and returns the final status", async () => {
    const server = await sequence([status(503), ok("")]);
    const { downloader, events } = harness();
    await expect(
      downloader.probe({
        url: server.url,
        allowInsecureHttp: true,
        allowPrivateNetwork: true,
        limits: { maxBytes: 10, timeoutMs: 1_000 },
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(events).toEqual([expect.objectContaining({ method: "HEAD", status: 503 })]);

    const failing = await sequence([status(503)]);
    await expect(
      harness().downloader.probe({
        url: failing.url,
        allowInsecureHttp: true,
        allowPrivateNetwork: true,
        limits: { maxBytes: 10, timeoutMs: 1_000 },
      }),
    ).resolves.toMatchObject({ status: 503 });
    expect(failing.count()).toBe(3);
  });
});
