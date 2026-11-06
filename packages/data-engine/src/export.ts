import type { JS } from "@duckdb/node-api";
import type { TabularStage } from "./tabular-stage.js";
import { sqlString } from "./sql-path.js";
import type { SupportedDataFormat } from "./types.js";
import { writeXlsx, type XlsxWriteValue } from "./xlsx-writer.js";

function excelValue(value: JS): XlsxWriteValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

async function* stageRows(
  stage: TabularStage,
  select: string,
): AsyncGenerator<readonly XlsxWriteValue[]> {
  yield stage.columns.map((column) => column.name);
  const result = await stage.connection.stream(select);
  for await (const batch of result.yieldRowsJs())
    for (const values of batch) yield values.map(excelValue);
}

async function exportXlsx(stage: TabularStage, output: string, select: string): Promise<void> {
  await writeXlsx(output, [{ name: "Data", rows: stageRows(stage, select) }]);
}

export async function exportStage(
  stage: TabularStage,
  output: string,
  targetFormat: SupportedDataFormat,
  select: string,
): Promise<void> {
  if (targetFormat === "xlsx") {
    await exportXlsx(stage, output, select);
    return;
  }
  const destination = sqlString(output);
  let options: string;
  switch (targetFormat) {
    case "csv":
      options = "FORMAT CSV, HEADER true, DELIMITER ','";
      break;
    case "tsv":
      options = "FORMAT CSV, HEADER true, DELIMITER '\\t'";
      break;
    case "json":
      options = "FORMAT JSON, ARRAY true";
      break;
    case "ndjson":
      options = "FORMAT JSON, ARRAY false";
      break;
    case "parquet":
      options = "FORMAT PARQUET";
      break;
  }
  // This is a KLOPSI-owned COPY template. select is assembled exclusively from
  // the staged table's quoted identifiers and fixed spreadsheet-safe CASEs.
  await stage.connection.run(`COPY (${select}) TO ${destination} (${options})`);
}
