import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_PARAMETERS,
  MAX_QUERY_PARAMETER_VALUE_BYTES,
  parseQueryParameter,
  validateQueryParameters,
} from "../src/query-parameters.js";

describe("parseQueryParameter", () => {
  it.each([
    ["city=Ljubljana", { name: "city", type: "varchar", value: "Ljubljana" }],
    ["city=", { name: "city", type: "varchar", value: "" }],
    ["expr=a=b", { name: "expr", type: "varchar", value: "a=b" }],
    ["_x1:varchar=1", { name: "_x1", type: "varchar", value: "1" }],
    ["n:int=5", { name: "n", type: "int", value: "5" }],
    ["n:int=-9223372036854775808", { name: "n", type: "int", value: "-9223372036854775808" }],
    ["ratio:double=1.5", { name: "ratio", type: "double", value: "1.5" }],
    ["ratio:double=-2e3", { name: "ratio", type: "double", value: "-2e3" }],
    ["flag:bool=true", { name: "flag", type: "bool", value: "true" }],
    ["flag:bool=false", { name: "flag", type: "bool", value: "false" }],
    ["day:date=2024-02-29", { name: "day", type: "date", value: "2024-02-29" }],
    ["q='; drop table data; --", { name: "q", type: "varchar", value: "'; drop table data; --" }],
  ])("parses %s", (text, expected) => {
    expect(parseQueryParameter(text)).toEqual(expected);
  });

  it.each([
    ["missing equals", "city"],
    ["empty name", "=value"],
    ["leading digit", "1city=x"],
    ["dollar prefix", "$city=x"],
    ["punctuation", "ci-ty=x"],
    ["whitespace", "city name=x"],
    ["too long", `${"a".repeat(64)}=x`],
    ["unknown type", "n:integer=5"],
    ["empty type", "n:=5"],
    ["int text", "n:int=five"],
    ["int decimal", "n:int=1.5"],
    ["int overflow", "n:int=9223372036854775808"],
    ["int empty", "n:int="],
    ["double text", "x:double=abc"],
    ["double infinity", "x:double=Infinity"],
    ["double nan", "x:double=NaN"],
    ["double hex", "x:double=0x10"],
    ["double overflow", "x:double=1e400"],
    ["bool yes", "f:bool=yes"],
    ["bool upper", "f:bool=TRUE"],
    ["date format", "d:date=2024/01/01"],
    ["date invalid day", "d:date=2023-02-29"],
    ["date invalid month", "d:date=2024-13-01"],
    ["date year zero", "d:date=0000-01-01"],
  ])("rejects %s with exit 2", (_label, text) => {
    expect(() => parseQueryParameter(text)).toThrow(
      expect.objectContaining({ code: "QUERY_PARAM_INVALID", exitCode: 2 }),
    );
  });

  it("rejects malformed UTF-16 text values", () => {
    expect(() => parseQueryParameter("x=\ud800")).toThrow(
      expect.objectContaining({ code: "QUERY_PARAM_INVALID", exitCode: 2 }),
    );
  });

  it("does not echo parameter values in errors", () => {
    let error: unknown;
    try {
      parseQueryParameter("n:int=secret-value");
    } catch (caught) {
      error = caught;
    }
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect((error as Error).message).not.toContain("secret-value");
  });
});

describe("validateQueryParameters", () => {
  it("accepts an empty list", () => {
    expect(validateQueryParameters([])).toEqual([]);
  });

  it("rejects case-insensitive duplicate names", () => {
    expect(() =>
      validateQueryParameters([
        { name: "city", type: "varchar", value: "a" },
        { name: "City", type: "varchar", value: "b" },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "QUERY_PARAM_DUPLICATE",
        exitCode: 2,
        context: { name: "City" },
      }),
    );
  });

  it("revalidates structured parameters", () => {
    expect(() =>
      validateQueryParameters([{ name: "n", type: "int", value: "1; DROP TABLE data" }]),
    ).toThrow(expect.objectContaining({ code: "QUERY_PARAM_INVALID", exitCode: 2 }));
    expect(() =>
      validateQueryParameters([{ name: "n", type: "blob" as unknown as "varchar", value: "x" }]),
    ).toThrow(expect.objectContaining({ code: "QUERY_PARAM_INVALID", exitCode: 2 }));
  });

  it("bounds the number of parameters and the size of each value", () => {
    expect(() =>
      validateQueryParameters(
        Array.from({ length: MAX_QUERY_PARAMETERS + 1 }, (_, index) => ({
          name: `p${index}`,
          type: "varchar" as const,
          value: "x",
        })),
      ),
    ).toThrow(expect.objectContaining({ code: "QUERY_PARAM_LIMIT", exitCode: 2 }));
    expect(() =>
      validateQueryParameters([
        {
          name: "big",
          type: "varchar",
          value: "é".repeat(MAX_QUERY_PARAMETER_VALUE_BYTES / 2 + 1),
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "QUERY_PARAM_LIMIT", exitCode: 2 }));
  });
});
