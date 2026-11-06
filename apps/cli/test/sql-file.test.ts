import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SQL_FILE_BYTES, readSqlFile } from "../src/sql-file.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "klopsi-sql-file-"));
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

function stdin(chunks: readonly (string | Uint8Array)[], isTTY = false) {
  return Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), { isTTY });
}

describe("readSqlFile", () => {
  it("reads UTF-8 SQL relative to the invocation directory", async () => {
    await writeFile(join(directory, "query.sql"), "SELECT 'Šiška' AS place\n");
    await expect(readSqlFile("query.sql", { cwd: directory })).resolves.toBe(
      "SELECT 'Šiška' AS place\n",
    );
  });

  it("strips one UTF-8 byte order mark", async () => {
    await writeFile(
      join(directory, "bom.sql"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("SELECT 1")]),
    );
    await expect(readSqlFile(join(directory, "bom.sql"), {})).resolves.toBe("SELECT 1");
  });

  it("follows a symlink to a regular file", async () => {
    await writeFile(join(directory, "target.sql"), "SELECT 2");
    await symlink(join(directory, "target.sql"), join(directory, "link.sql"));
    await expect(readSqlFile(join(directory, "link.sql"), {})).resolves.toBe("SELECT 2");
  });

  it("reports a missing file as not found", async () => {
    await expect(readSqlFile(join(directory, "missing.sql"), {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_NOT_FOUND",
      exitCode: 3,
    });
  });

  it("rejects directories", async () => {
    await mkdir(join(directory, "folder"));
    await expect(readSqlFile(join(directory, "folder"), {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_INVALID",
      exitCode: 2,
    });
  });

  it.skipIf(process.platform === "win32")("rejects FIFOs without blocking", async () => {
    const fifo = join(directory, "pipe.sql");
    execFileSync("mkfifo", [fifo]);
    await expect(readSqlFile(fifo, {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_INVALID",
      exitCode: 2,
    });
  });

  it("rejects files larger than the SQL file limit", async () => {
    await writeFile(join(directory, "large.sql"), Buffer.alloc(MAX_SQL_FILE_BYTES + 1, 0x20));
    await expect(readSqlFile(join(directory, "large.sql"), {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_TOO_LARGE",
      exitCode: 2,
      context: { maximumBytes: MAX_SQL_FILE_BYTES },
    });
  });

  it("accepts a file exactly at the limit", async () => {
    await writeFile(join(directory, "edge.sql"), Buffer.alloc(MAX_SQL_FILE_BYTES, 0x20));
    await expect(readSqlFile(join(directory, "edge.sql"), {})).resolves.toHaveLength(
      MAX_SQL_FILE_BYTES,
    );
  });

  it("rejects invalid UTF-8", async () => {
    await writeFile(join(directory, "latin2.sql"), Buffer.from([0x53, 0x45, 0x4c, 0xe8, 0x20]));
    await expect(readSqlFile(join(directory, "latin2.sql"), {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_ENCODING",
      exitCode: 2,
    });
  });

  it("reads SQL from piped stdin with '-'", async () => {
    await expect(readSqlFile("-", { stdin: stdin(["\ufeffSELECT ", "'ž' AS x"]) })).resolves.toBe(
      "SELECT 'ž' AS x",
    );
  });

  it("decodes multibyte characters split across stdin chunks", async () => {
    const bytes = Buffer.from("SELECT 'č'");
    await expect(
      readSqlFile("-", { stdin: stdin([bytes.subarray(0, 9), bytes.subarray(9)]) }),
    ).resolves.toBe("SELECT 'č'");
  });

  it("bounds stdin", async () => {
    await expect(
      readSqlFile("-", {
        stdin: stdin([Buffer.alloc(MAX_SQL_FILE_BYTES), Buffer.alloc(1)]),
      }),
    ).rejects.toMatchObject({ code: "QUERY_SQL_FILE_TOO_LARGE", exitCode: 2 });
  });

  it("rejects invalid UTF-8 on stdin", async () => {
    await expect(
      readSqlFile("-", { stdin: stdin([Buffer.from([0xff, 0xfe])]) }),
    ).rejects.toMatchObject({ code: "QUERY_SQL_FILE_ENCODING", exitCode: 2 });
  });

  it("refuses an interactive or unavailable stdin", async () => {
    await expect(readSqlFile("-", { stdin: stdin([], true) })).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_INVALID",
      exitCode: 2,
    });
    await expect(readSqlFile("-", {})).rejects.toMatchObject({
      code: "QUERY_SQL_FILE_INVALID",
      exitCode: 2,
    });
  });
});
