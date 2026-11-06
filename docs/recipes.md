# Recipes

Search and inspect: `klopsi search promet --json --limit 5`, then `klopsi dataset show ID --json` and `klopsi dataset resources ID`.

Download and reuse offline: `klopsi download opsi:resource:ID --output ./downloads`, then set `KLOPSI_OFFLINE=1` or use `--offline` for cached catalogue work.

Inspect and validate: `klopsi resource preview ./downloads/data.csv --limit 10 --json`; `klopsi validate ./downloads/data.csv --json`.

Query and export: `klopsi query ./downloads/data.csv --sql "select * from data limit 10" --output result.json --json`.

## Parameterized SQL files

Keep long SQL in a file and pass user-supplied values as bound parameters instead of editing SQL text:

```sh
cat > by-region.sql <<'SQL'
select region, station, CAST(vehicles AS BIGINT) AS vehicles
from data
where region = $region and CAST(vehicles AS BIGINT) >= $min
order by vehicles desc
SQL
klopsi query ./downloads/traffic.csv --sql-file by-region.sql \
  --param region=Gorenjska --param min:int=1000 \
  --output gorenjska.csv --json
klopsi provenance show gorenjska.csv --json
```

`--param` values are bound through DuckDB prepared statements, so a value such as `O'Brien` or `'; drop table data; --` is matched literally. Use `--sql-file -` to read the statement from a pipe, for example `generate-sql | klopsi query data.csv --sql-file - --json`. The export provenance records both the SQL and the parameters.

Convert and verify: `klopsi convert data.csv --to parquet --output data.parquet`; `klopsi provenance show data.parquet`; `klopsi provenance verify data.parquet --json`.

## Dense PC-Axis

Inspect a `.px` resource before analysis, then keep its long-form code and missing-symbol semantics:

```sh
klopsi resource inspect table.px --json
klopsi resource preview table.px --limit 10 --json
klopsi validate table.px --json
klopsi query table.px \
  --sql 'select "Municipality__code", "Year", value, value__symbol from data where value IS NULL' \
  --json
klopsi convert table.px --to parquet --output table.parquet
klopsi provenance verify table.parquet --json
```

A municipality code such as `061` remains a string in `Municipality__code`; do not cast it to a number. Labels remain in `Municipality`. A row with `value IS NULL` and a non-null `value__symbol` reflects a source suppression/missing token, while numeric zero remains `value = 0`. PC-Axis is input-only, so choose CSV, TSV, JSON, NDJSON, XLSX, or Parquet as the conversion target. v1 rejects sparse `KEYS` cubes explicitly rather than returning partial rows.

## Complete reproducible workflow

Create a directory, search, inspect, download by canonical reference, validate locally, query, convert, and verify:

```sh
WORKFLOW_TMP="$(mktemp -d)"
klopsi search promet --json --limit 1
klopsi dataset show dataset-traffic-001 --json
klopsi download opsi:resource:resource-traffic-csv-001 --output "$WORKFLOW_TMP"
klopsi resource preview resource-traffic-csv-001 --json
klopsi validate "$WORKFLOW_TMP/traffic.csv" --json
klopsi query "$WORKFLOW_TMP/traffic.csv" --sql "select * from data limit 2" --json
klopsi convert "$WORKFLOW_TMP/traffic.csv" --to parquet --output "$WORKFLOW_TMP/traffic.parquet"
klopsi provenance verify "$WORKFLOW_TMP/traffic.parquet" --json
```

Use real IDs returned by search. Public HTTPS needs no override. For a deliberately controlled loopback fixture only, add both remote-content overrides; provenance records them.

## Offline and automation

Warm metadata/content online, then add `--offline` or `KLOPSI_OFFLINE=1`. Cached downloads materialize into a new destination and preserve digest/provenance without requests. `resource headers` cannot operate offline. For scripts choose `--json`, check the exit status, and parse `data`; partial downloads use exit 8 with successful `data` plus failure metadata. Set `NO_COLOR=1` and never scrape human tables.

Generate shell setup with `klopsi completion bash`, `zsh`, or `fish`. The script is static and safe to generate offline. Store it in your shell's completion directory. It completes command-specific options/choices/providers and filesystem paths.

## Data safety recipes

Inspect before converting: preview a bounded sample, validate, then convert to a new destination. Use `--sheet` for ambiguous XLSX and `--spreadsheet-safe` when CSV/XLSX output will open in office software. Do not use `--force` until provenance for the existing file is saved/verified. Query exports support only bounded CSV/TSV/JSON/NDJSON outputs; convert to Parquet separately and verify its sidecar.

Diagnose installations with `klopsi doctor --offline --json`. A `skip` connectivity check is expected offline; any `fail` produces a nonzero status after all checks finish. Catalogue/configuration commands remain usable after typed DuckDB absence, which is useful for inspecting provider data while fixing the native installation.

## ZIP, XML, and WFS

Inspect capabilities before choosing an operation: `klopsi resource inspect opsi:resource:ID --json`. For an ambiguous ZIP, use the returned choice exactly: `klopsi resource preview archive.zip --entry data/rows.csv --limit 10 --json`. For generic XML, select a returned record path: `klopsi query stations.xml --record-path /root/station --sql "select * from data limit 10" --json`.

For WFS, keep the canonical resource reference throughout: `klopsi service layers opsi:resource:ID --json`; `klopsi service schema opsi:resource:ID --layer si:roads --json`; `klopsi service preview opsi:resource:ID --layer si:roads --property id,name --limit 5 --json`; `klopsi service count opsi:resource:ID --layer si:roads --filter-eq municipality=Ljubljana --json`. WFS is read-only: no transactions, raw CQL/XML filters, or raw HTTP fallback.
