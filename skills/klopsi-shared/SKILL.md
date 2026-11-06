---
name: klopsi-shared
description: "Use when any KLOPSI CLI skill needs shared installation, output, offline, safety, or error-handling guidance."
---

# KLOPSI shared execution contract

Read this before using any KLOPSI domain skill. Generated for `klopsi` 0.0.2.

## Install and discover

```sh
npm install --global klopsi
klopsi --version
klopsi --help
klopsi <command> --help
```

Use the installed CLI as the source of truth when its help differs from generated skill text.

## Structured output

- Prefer `--json` for one bounded result envelope or `--ndjson` for streamed records.
- Use `--fields` and command-specific row limits to keep agent context small.
- Read result data from stdout, diagnostics from stderr, and the exit status as the authoritative success signal.
- Inspect the structured `error.code` together with the exit status before choosing remediation.
- Never parse a human-readable table when structured output is available.

## Default decision sequence

1. Resolve a local path, a local:file reference, or an exact `opsi:resource:` reference.
2. Inspect unknown inputs, then preview a bounded sample and validate when the next operation depends on content integrity.
3. Download provider data before local-only work, then use `--offline` for the remaining local steps when network access is unavailable or unwanted.
4. Perform the requested bounded operation and verify important artifacts with provenance.

## Input and selector choices

- Use a local path for data already on disk and a canonical `opsi:resource:` reference for provider data; do not invent IDs or references.
- Use one `--entry` or `--record-path` reported by resource inspect or the relevant operation's structured error/output; resource inspect can surface ZIP entries and XML record paths.
- Without `--sheet`, XLSX resource preview, validate, or query emits `SHEET_REQUIRED` with `context.sheets` and a suggestion; use one listed sheet.

## Formats and outputs

- Supported tabular workflow formats include JSON, NDJSON, CSV, TSV, XLSX, Parquet, ZIP, XML, and dense PC-Axis when their selected content is supported.
- PC-Axis is input-only and becomes deterministic long-form rows. Preserve sibling `__code` strings and distinguish a source-symbol null (`value: null` plus `value__symbol`) from numeric zero.
- Choose `--json` for one bounded envelope, `--ndjson` for records, and command-specific `--output` for a persisted artifact; use spreadsheet-safe output when needed.

## Presentation artifacts

- Read [the dashboard presentation contract](references/presentation-contract.md) before creating a static or interactive HTML presentation.
- Run `node ../klopsi-shared/scripts/verify-dashboard.mjs <dashboard.html> --mode <static|interactive> --json` and repair every finding before handoff.
- Passing the dashboard verifier is presentation evidence, not official artifact provenance; use `klopsi provenance verify` for provenance claims.

## Global options

| Option | Values | Conflicts | Description |
| --- | --- | --- | --- |
| `--json` | — | `--ndjson`, `--csv`, `--tsv`, `--output-format` | render JSON |
| `--ndjson` | — | `--json`, `--csv`, `--tsv`, `--output-format` | render newline-delimited JSON |
| `--csv` | — | `--json`, `--ndjson`, `--tsv`, `--output-format` | render CSV |
| `--tsv` | — | `--json`, `--ndjson`, `--csv`, `--output-format` | render TSV |
| `--output-format <format>` | `table`, `json`, `ndjson`, `csv`, `tsv` | — | select output format |
| `--fields <field>` | field | — | select output field (repeatable or comma-separated) |
| `--provider <id>` | `opsi`, `local` | — | select provider |
| `--offline` | — | — | disable network access |
| `--cache-dir <path>` | path | — | override cache directory |
| `--download-dir <path>` | path | — | override download directory |
| `--http-timeout-ms <number>` | number | — | HTTP timeout in milliseconds |
| `--http-retries <number>` | number | — | retries for transient download failures (0 disables) |
| `--max-download-bytes <number>` | number | — | maximum download size |
| `--preview-row-limit <number>` | number | — | preview row limit |
| `--query-row-limit <number>` | number | — | query row limit |
| `--query-timeout-ms <number>` | number | — | query timeout in milliseconds |
| `--duckdb-memory-limit <limit>` | limit | — | DuckDB memory limit |
| `--duckdb-threads <number>` | number | — | DuckDB worker threads |
| `--quiet` | — | — | suppress non-result output |
| `--debug` | — | — | include diagnostic stack traces |
| `--no-color` | — | — | disable color output |

## Network and offline behavior

- Pass `--offline` when network access is prohibited. Do not imply that an uncached request can succeed offline.
- Preserve HTTPS, DNS, redirect, timeout, download-size, query, memory, thread, cell, and output bounds.
- Use `--allow-insecure-http` or `--allow-private-network` only after the user explicitly accepts that invocation's risk.
- Do not blindly retry invalid input, unsupported operations, validation failures, or integrity failures.

## Safety

- Prefer structured output and bounded result sets.
- Honor offline requests and existing network safeguards.
- Confirm destructive or overwrite operations unless already explicitly authorized.
- Do not fall back to curl or another raw HTTP client for an operation supported by klopsi.

## Confirm mutations

- Confirm before `cache clear` or `cache prune` unless the user already requested that exact operation.
- Confirm before using `--force` to replace an artifact unless that exact overwrite is already authorized.
- Do not persist secret-like configuration values; use the environment for secrets.

## Exit categories

| Exit | Meaning | Response |
| --- | --- | --- |
| 0 | Success | Use the structured result. |
| 1 | Internal failure | Report diagnostics; retry only when evidence suggests a transient failure. |
| 2 | Invalid input or configuration | Correct the command or configuration before retrying. |
| 3 | Not found | Check the exact dataset, resource, or local path. |
| 4 | Provider or network failure | Respect offline mode and retry only transient failures. |
| 5 | Unsupported operation | Choose a supported provider, format, or installed native dependency. |
| 6 | Validation or integrity failure | Report issues and repair or replace the input. |
| 7 | Query failure | Correct the bounded read-only SQL or resource input. |
| 8 | Partial success | Report successes and failures separately. |

## Shell discipline

- Quote paths and user-provided values safely.
- Never print credentials, authorization headers, cookies, or secret environment values.
- Use canonical references returned by `klopsi` when available.
