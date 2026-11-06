import { describe, expect, it } from "vitest";
import { QueryPolicy } from "../src/query-policy.js";

describe("QueryPolicy", () => {
  it.each([
    "SELECT 1",
    "WITH row AS (SELECT 1 AS value) SELECT * FROM row",
    "VALUES (1), (2)",
    "-- comment;\nSELECT ';' AS value /* ; */",
    "\u2003SELECT 1",
    "SELECT $city AS city WHERE $limit > 0",
  ])("accepts one read-only SELECT statement: %s", async (sql) => {
    await expect(QueryPolicy.validate(sql)).resolves.toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["multiple", "SELECT 1; SELECT 2"],
    ["copy", "COPY data TO '/tmp/out.csv'"],
    ["attach", "ATTACH '/tmp/other.db' AS other"],
    ["detach", "DETACH other"],
    ["install", "INSTALL httpfs"],
    ["force install", "FORCE INSTALL httpfs"],
    ["load", "LOAD httpfs"],
    ["pragma", "PRAGMA version"],
    ["set", "SET enable_external_access = true"],
    ["call", "CALL checkpoint()"],
    ["create", "CREATE TABLE x(i INTEGER)"],
    ["drop", "DROP TABLE data"],
    ["insert", "INSERT INTO data VALUES (1)"],
    ["update", "UPDATE data SET i = 1"],
    ["delete", "DELETE FROM data"],
    ["transaction", "BEGIN TRANSACTION"],
    ["export", "EXPORT DATABASE '/tmp/export'"],
    ["explain", "EXPLAIN SELECT 1"],
    ["parameterized copy", "COPY (SELECT $x) TO '/tmp/out.csv'"],
    ["parameterized multiple", "SELECT $x; DROP TABLE data"],
  ])("rejects %s SQL", async (_label, sql) => {
    await expect(QueryPolicy.validate(sql)).rejects.toMatchObject({
      code: "QUERY_FORBIDDEN",
      exitCode: 7,
    });
  });

  it("rejects SQL larger than its UTF-8 byte limit", async () => {
    await expect(QueryPolicy.validate(`SELECT '${"x".repeat(65_537)}'`)).rejects.toMatchObject({
      code: "QUERY_SQL_TOO_LARGE",
      exitCode: 7,
    });
  });
});
