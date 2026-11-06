---
name: klopsi-analysis
description: "Use when querying or converting bounded data, including ZIP, XML, JSON, XLSX, Parquet, or query exports."
---

# klopsi-analysis

> **Prerequisite:** Read [klopsi-shared](../klopsi-shared/SKILL.md) before executing these commands.

Analyze tabular inputs with bounded read-only SQL or convert supported formats. Generated for `klopsi` 0.0.2.

## Workflow

- Preview and validate input before running a bounded query.
- Convert an input and then verify the generated provenance record.

## Capability guide

### Choose a supported input

- Query or convert CSV, TSV, JSON, NDJSON, XLSX, Parquet, ZIP, XML, or dense PC-Axis only after inspection identifies usable tabular content.
- Use a resolved `--entry`, `--record-path`, or `--sheet` whenever ZIP, XML, or XLSX input is ambiguous.
- PC-Axis is input-only: convert it to CSV, TSV, JSON, NDJSON, XLSX, or Parquet, never to PC-Axis.
- In staged PC-Axis rows, keep `__code` fields as strings and interpret a source-symbol null as `value IS NULL` with the original token in `value__symbol`; do not confuse it with numeric zero.

### Run bounded read-only SQL

- Use one read-only `SELECT`, `WITH ... SELECT`, or `VALUES` statement, with an explicit `--limit` and a suitable timeout.
- Keep global query row, time, memory, and thread bounds appropriate to the requested result; correct exit 7 rather than retrying the same query.
- Never splice user-supplied values into SQL text; write `$name` placeholders and pass each value with repeatable `--param name=value`, or `name:int=`, `name:double=`, `name:bool=`, `name:date=` for typed values.
- Put long or multi-line SQL in a UTF-8 file and pass `--sql-file <path>` (or `--sql-file -` for piped stdin) instead of shell-quoting it with `--sql`; use exactly one of the two.
- Treat exit 2 `QUERY_PARAM_*` errors as an argument mismatch: supply every placeholder listed in `context.missing`, drop names in `context.unused`, and correct invalid typed values.

### Export query results

- Use `--output` for a bounded query export and choose a new path unless the user explicitly authorizes `--force`.
- Run `provenance verify` on an important query export before reporting it as a final artifact.

### Convert safely

- Choose a supported conversion target and `--output`; use `--spreadsheet-safe` for CSV or XLSX intended for spreadsheet software.
- Validate or inspect the converted result and use `provenance verify`; do not overwrite an existing destination without authorization.

## Commands

### `query`

Run one sandboxed read-only query over tabular data.

```sh
klopsi query <input> [options]
```

#### Arguments

| Argument | Values | Description |
| --- | --- | --- |
| `<input>` | — | local path or canonical resource reference |

#### Options

| Option | Required | Values | Conflicts | Description |
| --- | --- | --- | --- | --- |
| `--sql <query>` | no | query | `--sql-file` | one SELECT, WITH ... SELECT, or VALUES statement (or use --sql-file) |
| `--sql-file <path>` | no | path | `--sql` | read the statement from a UTF-8 file, or stdin with - (or use --sql) |
| `--param <name=value>` | no | name=value | — | bind a $name placeholder (repeatable; typed name:type=value with int, double, bool, or date) |
| `--limit <rows>` | no | rows | — | maximum returned rows |
| `--timeout-ms <milliseconds>` | no | milliseconds | — | hard query deadline |
| `--sheet <name>` | no | name | — | XLSX sheet name |
| `--entry <path>` | no | path | — | ZIP data entry path |
| `--record-path <path>` | no | path | — | XML record element path |
| `--output <path>` | no | path | — | export bounded results (.csv, .tsv, .json, .ndjson) |
| `--force` | no | — | — | replace an existing output |
| `--allow-insecure-http` | no | — | — | allow HTTP for this invocation |
| `--allow-private-network` | no | — | — | allow private network addresses for this invocation |


### `convert`

Convert tabular data between supported formats.

```sh
klopsi convert <input> --to <format> --output <path> [options]
```

#### Arguments

| Argument | Values | Description |
| --- | --- | --- |
| `<input>` | — | local path or canonical resource reference |

#### Options

| Option | Required | Values | Conflicts | Description |
| --- | --- | --- | --- | --- |
| `--to <format>` | yes | `csv`, `tsv`, `json`, `ndjson`, `xlsx`, `parquet` | — | destination data format |
| `--output <path>` | yes | path | — | destination file path |
| `--sheet <name>` | no | name | — | XLSX sheet name |
| `--entry <path>` | no | path | — | ZIP data entry path |
| `--record-path <path>` | no | path | — | XML record element path |
| `--force` | no | — | — | replace an existing regular destination |
| `--spreadsheet-safe` | no | — | — | prefix formula-like string values |
| `--allow-insecure-http` | no | — | — | allow HTTP for this invocation |
| `--allow-private-network` | no | — | — | allow private network addresses for this invocation |

## Safety

- Keep SQL read-only and bounded.
- Confirm before replacing an existing output with --force.

## Related skills

- [klopsi-resources](../klopsi-resources/SKILL.md)
- [klopsi-validation](../klopsi-validation/SKILL.md)
- [klopsi-provenance](../klopsi-provenance/SKILL.md)
