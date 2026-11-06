import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import {
  CacheLock,
  Downloader,
  SafeDispatcherFactory,
  assertPublicAddressSet,
  safeFilename,
} from "@klopsi/storage";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listen failed");
  return `http://127.0.0.1:${address.port}`;
}
async function destination(name = "file.txt"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "klopsi-download-"));
  roots.push(directory);
  return join(directory, name);
}
const localOptions = (url: string, path: string, maxBytes = 100) => ({
  url,
  destination: path,
  allowInsecureHttp: true,
  allowPrivateNetwork: true,
  limits: { maxBytes, timeoutMs: 1_000 },
});
describe("network policy", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ])("rejects special address %s", (address) => {
    expect(() =>
      assertPublicAddressSet([{ address, family: address.includes(":") ? 6 : 4 }]),
    ).toThrow();
  });
  it("fails closed on mixed DNS and passes the validated address to socket lookup", async () => {
    expect(() =>
      assertPublicAddressSet([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).toThrow();
    const factory = new SafeDispatcherFactory({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const lookup = factory.lookupFor(new URL("https://example.com"));
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) =>
      lookup("example.com", {}, (error, address, family) =>
        error ? reject(error) : resolve({ address: address as string, family: family as number }),
      ),
    );
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects private hostnames and revalidates every connection-time lookup against rebinding", async () => {
    let call = 0;
    const factory = new SafeDispatcherFactory({
      resolver: async () =>
        call++ === 0
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
    });
    const lookup = factory.lookupFor(new URL("https://rebind.example"));
    const invoke = () =>
      new Promise<{ address: string; family: number }>((resolve, reject) =>
        lookup("rebind.example", {}, (error, address, family) =>
          error ? reject(error) : resolve({ address: address as string, family: family as number }),
        ),
      );
    await expect(invoke()).resolves.toEqual({ address: "93.184.216.34", family: 4 });
    await expect(invoke()).rejects.toMatchObject({ code: "NETWORK_ADDRESS_FORBIDDEN" });

    const localhost = new SafeDispatcherFactory({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    }).lookupFor(new URL("https://localhost"));
    await expect(
      new Promise((resolve, reject) =>
        localhost("localhost", {}, (error, address) => (error ? reject(error) : resolve(address))),
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ADDRESS_FORBIDDEN" });
  });

  it("pins the actual Undici socket lookup with no preflight resolver call", async () => {
    const base = await listen((_request, response) => response.end("pinned"));
    const port = new URL(base).port;
    const calls: string[] = [];
    const factory = new SafeDispatcherFactory({
      resolver: async (hostname) => {
        calls.push(hostname);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    await expect(
      new Downloader(factory).download({
        url: `http://pinned.test:${port}/`,
        destination: await destination("pinned"),
        allowInsecureHttp: true,
        allowPrivateNetwork: true,
        limits: { maxBytes: 100, timeoutMs: 1_000 },
      }),
    ).resolves.toMatchObject({ bytes: 6 });
    expect(calls).toEqual(["pinned.test"]);
  });

  it("preserves hostname network-policy errors through Undici", async () => {
    const factory = new SafeDispatcherFactory({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(
      new Downloader(factory).download({
        url: "https://blocked.test/",
        destination: await destination("blocked"),
        limits: { maxBytes: 100, timeoutMs: 500 },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_ADDRESS_FORBIDDEN" });
  });
});

describe("Downloader", () => {
  it("bounds chunked responses and removes partial files", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write("12345");
      response.end("67890");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen failed");
    const directory = await mkdtemp(join(tmpdir(), "klopsi-download-"));
    roots.push(directory);
    const destination = join(directory, "file.txt");
    await expect(
      new Downloader().download({
        url: `http://127.0.0.1:${address.port}/x`,
        destination,
        allowInsecureHttp: true,
        allowPrivateNetwork: true,
        limits: { maxBytes: 5, timeoutMs: 1_000 },
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual([]);
    server.close();
    await once(server, "close");
  });

  it("follows relative redirects manually and hashes durable bytes", async () => {
    const server = createServer((request, response) =>
      request.url === "/start"
        ? (response.writeHead(302, { location: "/final" }), response.end())
        : (response.writeHead(200, { "content-type": "text/plain" }), response.end("hello")),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen failed");
    const directory = await mkdtemp(join(tmpdir(), "klopsi-download-"));
    roots.push(directory);
    const result = await new Downloader().download({
      url: `http://127.0.0.1:${address.port}/start`,
      destination: join(directory, "file.txt"),
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      limits: { maxBytes: 100, timeoutMs: 1_000 },
    });
    expect(result).toMatchObject({
      bytes: 5,
      redirectChain: [expect.stringContaining("/start"), expect.stringContaining("/final")],
    });
    expect(await readFile(result.path, "utf8")).toBe("hello");
    server.close();
    await once(server, "close");
  });

  it("enforces the allowed origin before following redirects", async () => {
    let targetRequests = 0;
    const target = await listen((_request, response) => {
      targetRequests += 1;
      response.end("forbidden");
    });
    const source = await listen((request, response) => {
      if (request.url === "/cross-origin") {
        response.writeHead(302, { location: `${target}/snapshot.json` }).end();
        return;
      }
      if (request.url === "/same-origin") {
        response.writeHead(302, { location: "/snapshot.json" }).end();
        return;
      }
      response.end("allowed");
    });

    await expect(
      new Downloader().download({
        ...localOptions(`${source}/cross-origin`, await destination("cross-origin.json")),
        allowedOrigins: [source],
      }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_ORIGIN_FORBIDDEN",
      exitCode: 4,
      context: { origin: new URL(target).origin },
    });
    expect(targetRequests).toBe(0);

    await expect(
      new Downloader().download({
        ...localOptions(`${source}/same-origin`, await destination("same-origin.json")),
        allowedOrigins: [`${source}/ignored/path`],
      }),
    ).resolves.toMatchObject({ bytes: 7, finalUrl: `${source}/snapshot.json` });
  });

  it.each([
    ["insecure HTTP", "http://other.example/snapshot.json"],
    ["private network", "https://127.0.0.1/snapshot.json"],
    ["other origin", "https://other.example/snapshot.json"],
  ])("checks the allowed origin before initial %s policy", async (_kind, url) => {
    let dispatchers = 0;
    const factory = {
      create: () => {
        dispatchers += 1;
        throw new Error("dispatcher must not be opened");
      },
    } as unknown as SafeDispatcherFactory;

    await expect(
      new Downloader(factory).download({
        url,
        destination: await destination("initial-origin.json"),
        allowedOrigins: ["https://allowed.example"],
        limits: { maxBytes: 100, timeoutMs: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_ORIGIN_FORBIDDEN",
      exitCode: 4,
      context: { origin: new URL(url).origin },
    });
    expect(dispatchers).toBe(0);
  });

  it.each([
    ["HTTPS downgrade", "http://other.example/snapshot.json"],
    ["private network", "https://127.0.0.1/snapshot.json"],
    ["other origin", "https://other.example/snapshot.json"],
  ])("checks the allowed origin before redirect %s policy", async (_kind, location) => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get("https://public.example")
      .intercept({ method: "GET", path: "/start" })
      .reply(302, "", { headers: { location } });
    let dispatchers = 0;
    const factory = {
      create: () => {
        dispatchers += 1;
        return mock;
      },
    } as unknown as SafeDispatcherFactory;

    await expect(
      new Downloader(factory).download({
        url: "https://public.example/start",
        destination: await destination("redirect-origin.json"),
        allowedOrigins: ["https://public.example"],
        limits: { maxBytes: 100, timeoutMs: 1_000 },
      }),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_ORIGIN_FORBIDDEN",
      exitCode: 4,
      context: { origin: new URL(location).origin },
    });
    expect(dispatchers).toBe(1);
  });

  it.each(["../secret", "..\\secret", "CON", "nul.txt", "hello:ads", "trail. ", "\u0000bad"])(
    "sanitizes remote filename %j",
    (name) => {
      const safe = safeFilename(name, "download");
      expect(safe).not.toMatch(/[\\/:]|\p{Cc}/u);
      expect(safe).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
      expect(safe).not.toBe(".");
      expect(safe).not.toBe("..");
    },
  );

  it.each([
    "../secret",
    "/absolute/secret",
    "C:\\absolute\\secret",
    "..\\secret",
    "\u001b[31mterminal",
    "CON",
    "NUL.txt",
    "COM1.csv",
    "hello:ads",
    "trail. ",
    "",
    `${"x".repeat(300)}.csv`,
  ])("keeps untrusted filename %j inside a single safe leaf", (name) => {
    const safe = safeFilename(name, "download");
    expect(basename(safe)).toBe(safe);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(180);
    expect(safe).not.toMatch(/[\\/:]|\p{Cc}/u);
    expect(safe).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
  });

  it("bounds redirect loops and chains longer than five hops", async () => {
    const base = await listen((request, response) => {
      const match = /^\/chain\/(\d+)$/u.exec(request.url ?? "");
      if (request.url === "/loop") response.writeHead(302, { location: "/loop" }).end();
      else if (match !== null)
        response.writeHead(302, { location: `/chain/${Number(match[1]) + 1}` }).end();
      else response.end("hello");
    });
    await expect(
      new Downloader().download(localOptions(`${base}/loop`, await destination("loop.txt"))),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    await expect(
      new Downloader().download(localOptions(`${base}/chain/0`, await destination("chain.txt"))),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("cancels hostile unbounded redirect and error bodies instead of dumping them", async () => {
    const base = await listen((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.write(Buffer.alloc(256 * 1024));
        return;
      }
      if (request.url === "/error") {
        response.writeHead(500);
        response.write(Buffer.alloc(256 * 1024));
        return;
      }
      response.end("hello");
    });
    await expect(
      new Downloader().download({
        ...localOptions(`${base}/redirect`, await destination("redirect-body")),
        limits: { maxBytes: 100, timeoutMs: 500 },
      }),
    ).resolves.toMatchObject({ bytes: 5 });
    await expect(
      new Downloader().download({
        ...localOptions(`${base}/error`, await destination("error-body")),
        limits: { maxBytes: 100, timeoutMs: 500, retries: 0 },
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_HTTP_ERROR" });
  });

  it("strips credentials on cross-origin redirects", async () => {
    let received: Record<string, string | string[] | undefined> = {};
    const target = await listen((request, response) => {
      received = request.headers;
      response.end("hello");
    });
    const source = await listen((_request, response) =>
      response.writeHead(302, { location: `${target}/final` }).end(),
    );
    await new Downloader().download({
      ...localOptions(`${source}/start`, await destination()),
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        "x-safe": "keep",
      },
    });
    expect(received.authorization).toBeUndefined();
    expect(received.cookie).toBeUndefined();
    expect(received["proxy-authorization"]).toBeUndefined();
    expect(received["x-safe"]).toBe("keep");
  });

  it.each([
    { "Accept-Encoding": "gzip" },
    { "ACCEPT-ENCODING": "br" },
    { "Accept-Encoding": "gzip", "ACCEPT-ENCODING": "br" },
  ])("removes all caller Accept-Encoding case variants %#", async (headers) => {
    let encoding: string | undefined;
    let raw: string[] = [];
    const base = await listen((request, response) => {
      encoding = request.headers["accept-encoding"];
      raw = request.rawHeaders;
      response.end("hello");
    });
    await new Downloader().download({
      ...localOptions(base, await destination("encoding")),
      headers,
    });
    expect(encoding).toBe("identity");
    expect(raw.filter((value) => value.toLowerCase() === "accept-encoding")).toHaveLength(1);
  });

  it("denies redirects to private addresses, HTTPS downgrade, and forbidden schemes", async () => {
    const cases = [
      { location: "https://127.0.0.1/private", code: "NETWORK_ADDRESS_FORBIDDEN" },
      { location: "http://public.example/final", code: "HTTPS_DOWNGRADE_FORBIDDEN" },
      { location: "file:///etc/passwd", code: "INSECURE_DOWNLOAD_URL" },
    ];
    for (const item of cases) {
      const mock = new MockAgent();
      mock.disableNetConnect();
      mock
        .get("https://public.example")
        .intercept({ method: "GET", path: "/start" })
        .reply(302, "", { headers: { location: item.location } });
      const factory = { create: () => mock } as unknown as SafeDispatcherFactory;
      await expect(
        new Downloader(factory).download({
          url: "https://public.example/start",
          destination: await destination(),
          limits: { maxBytes: 100, timeoutMs: 1_000 },
        }),
      ).rejects.toMatchObject({ code: item.code });
    }
  });

  it("accepts missing Content-Length and rejects declared or actual oversized bodies", async () => {
    const missing = await listen((_request, response) => {
      response.write("he");
      response.end("llo");
    });
    await expect(
      new Downloader().download(localOptions(missing, await destination("missing.txt"))),
    ).resolves.toMatchObject({ bytes: 5 });

    const declared = await listen((_request, response) => {
      response.writeHead(200, { "content-length": "1000" });
      response.end();
    });
    const declaredPath = await destination("declared.txt");
    await expect(
      new Downloader().download(localOptions(declared, declaredPath, 5)),
    ).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
    await expect(lstat(declaredPath)).rejects.toMatchObject({ code: "ENOENT" });

    const falseLength = await listen((_request, response) => {
      response.writeHead(200, { "content-length": "10" });
      response.end("hello");
    });
    const falsePath = await destination("false.txt");
    await expect(
      new Downloader().download({
        ...localOptions(falseLength, falsePath),
        limits: { maxBytes: 100, timeoutMs: 1_000, retries: 0 },
      }),
    ).rejects.toThrow();
    await expect(lstat(falsePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes partial output after an abrupt connection close", async () => {
    const base = await listen((_request, response) => {
      response.writeHead(200);
      response.write("partial");
      response.socket?.destroy();
    });
    const path = await destination("abrupt.txt");
    await expect(new Downloader().download(localOptions(base, path))).rejects.toThrow();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(path, ".."))).filter((name) => name.includes(".part-"))).toEqual([]);
  });

  it("includes destination-lock waiting in the total deadline", async () => {
    const path = await destination("locked");
    const lock = await CacheLock.acquire(join(path, ".."), `download:${path}`);
    const started = Date.now();
    await expect(
      new Downloader().download({
        url: "https://never.test/",
        destination: path,
        limits: { maxBytes: 10, timeoutMs: 100 },
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    await lock.release();
  });

  it("handles identical, conflicting, forced, and concurrent destinations atomically", async () => {
    const base = await listen((_request, response) => response.end("hello"));
    const identical = await destination("identical.txt");
    await writeFile(identical, "hello");
    await expect(new Downloader().download(localOptions(base, identical))).resolves.toMatchObject({
      bytes: 5,
    });

    const conflicting = await destination("conflicting.txt");
    await writeFile(conflicting, "old");
    await expect(new Downloader().download(localOptions(base, conflicting))).rejects.toMatchObject({
      code: "DOWNLOAD_DESTINATION_EXISTS",
    });
    expect(await readFile(conflicting, "utf8")).toBe("old");
    await expect(
      new Downloader().download({ ...localOptions(base, conflicting), force: true }),
    ).resolves.toMatchObject({ bytes: 5 });
    expect(await readFile(conflicting, "utf8")).toBe("hello");

    const concurrent = await destination("concurrent.txt");
    await expect(
      Promise.all([
        new Downloader().download(localOptions(base, concurrent)),
        new Downloader().download(localOptions(base, concurrent)),
      ]),
    ).resolves.toHaveLength(2);
    expect(await readFile(concurrent, "utf8")).toBe("hello");
    expect(
      (await readdir(join(concurrent, ".."))).filter((name) => name.includes(".part-")),
    ).toEqual([]);
  });
});
