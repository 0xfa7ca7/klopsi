# Command reference

All commands send result data to stdout and warnings/diagnostics to stderr. Human tables are the interactive default. `--json`, `--ndjson`, `--csv`, `--tsv`, and `--output-format table|json|ndjson|csv|tsv` select machine output and are mutually exclusive. JSON uses `{schemaVersion,data,meta,error?}`. Stable exit categories are 0 success, 1 internal, 2 invalid input/configuration, 3 not found, 4 provider/network, 5 unsupported, 6 validation/integrity, 7 query, and 8 partial success. Stacks require `--debug` and are redacted.

Global controls are `--provider opsi|local`, repeatable/comma-separated `--fields`, `--offline`, `--cache-dir`, `--download-dir`, `--http-timeout-ms`, `--max-download-bytes`, `--preview-row-limit`, `--query-row-limit`, `--query-timeout-ms`, `--duckdb-memory-limit`, `--duckdb-threads`, `--quiet`, `--debug`, and `--no-color`. Field projection preserves the requested order in every output format. `NO_COLOR` also disables styling. Remote-content overrides `--allow-insecure-http` and `--allow-private-network` affect one invocation only.

## Catalogue

### `search`

Syntax: `klopsi search [text] [options]`. Filters: `--organization`, repeatable `--tag` and `--format`, `--license`, `--modified-after`, `--modified-before`, repeatable `--sort field:asc|desc`, positive `--limit`, nonnegative `--offset`, and `--all`. `--all` performs bounded advancing page traversal and conflicts with `--limit`. Output is dataset summaries with deterministic pagination metadata. Invalid sort/number values exit 2; provider failures exit 4. Example: `klopsi search promet --tag mobilnost --format CSV --all --fields id,title --json`.

### `dataset show`

Syntax: `klopsi dataset show <id>`. Returns complete normalized dataset metadata and embedded resources. A missing ID exits 3; malformed provider data or network failure exits 4. Example: `klopsi dataset show dataset-traffic-001 --json`.

### `dataset list`

Syntax: `klopsi dataset list [--refresh|--live]`. By default, this reads the centrally published catalogue snapshot, using a valid local cache when available and otherwise downloading the current snapshot. Snapshots must be no more than 24 hours old. Snapshot mode supports exactly the fields `id`, human-readable `title`, and provider slug `name`; global `--fields` can select and reorder those fields. JSON metadata includes `total`, `count`, `source` (`snapshot-cache` or `snapshot-remote`), `generatedAt`, and `stale: false`.

`--refresh` bypasses a fresh local snapshot and checks the published snapshot, but never queries OPSI directly; it is rejected in offline mode. Snapshot validation or retrieval failures are returned without a silent live fallback. In offline mode, normal listing succeeds only with a valid cached snapshot that is no more than 24 hours old; missing, invalid, and stale snapshots fail without network access.

`--live` is the explicit, slower direct-OPSI mode. It uses advancing 300-row provider pages, conflicts with `--refresh`, and is rejected in offline mode. Only live human, NDJSON, CSV, and TSV output streams each provider page as it arrives; live JSON buffers one envelope with `total`, `count`, `pages`, and `source: "live"`. Invalid live pagination exits 4. Examples: `klopsi dataset list --fields name,id --json`, `klopsi dataset list --refresh --json`, and `klopsi dataset list --live --ndjson`.

### `dataset resources`

Syntax: `klopsi dataset resources <id>`. Returns resources belonging to the dataset. Missing datasets exit 3. Example: `klopsi dataset resources dataset-traffic-001 --csv`.

### `dataset schema`

Syntax: `klopsi dataset schema <id> [--resource <id-or-reference>] [--sheet <name>] [--entry <path>] [--record-path <path>]`. If exactly one tabular resource exists it is selected; otherwise `--resource` is required. Use `--sheet` for XLSX, `--entry` for ambiguous ZIP archives, and `--record-path` for ambiguous XML. Network safety overrides are available. Output contains inferred fields/types. Dense PC-Axis schema exposes dimension labels, string `__code` siblings when CODES exist, numeric `value`, and sampled nullable `value__symbol`. Ambiguous selection exits 2, missing content exits 3, unsupported formats exit 5. Example: `klopsi dataset schema dataset-traffic-001 --resource resource-traffic-csv-001 --json`.

### `dataset open`

Syntax: `klopsi dataset open <id>`. Resolves metadata and opens only the validated `https://podatki.gov.si/dataset/...` public page through the platform browser. It never opens a resource URL. Invalid origins exit 2; missing metadata exits 3. Example: `klopsi dataset open dataset-traffic-001`.

### `resource show`

Syntax: `klopsi resource show <id>`. Returns normalized resource metadata, canonical reference, format, media type, and URL. Not found exits 3. Example: `klopsi resource show resource-traffic-csv-001 --json`.

### `resource preview`

Syntax: `klopsi resource preview <input> [--limit <rows>] [--sheet <name>] [--entry <path>] [--record-path <path>]`. Input may be local or a canonical resource. Previewing is bounded. XLSX, ambiguous ZIP, and ambiguous XML require their explicit selection option. Dense PC-Axis preview returns long-form rows; preserve zero-padded `__code` strings, and interpret `value: null` with `value__symbol` as a source data symbol rather than numeric zero. Example: `klopsi resource preview archive.zip --entry data/rows.csv --limit 10 --json`.

### `resource inspect`

Syntax: `klopsi resource inspect <input>`. Returns the resource kind/protocol, detected format, supported KLOPSI operations, selection choices, limitations, and safe next-action argv arrays. It does not recommend raw HTTP clients. Example: `klopsi resource inspect opsi:resource:RESOURCE_ID --json`.

### `resource headers`

Syntax: `klopsi resource headers <id>`. Securely probes remote status, headers, media type, and size with the same HTTPS, DNS, redirect, and timeout policy as downloads. It is unavailable on an offline cache miss. Example: `klopsi resource headers resource-traffic-csv-001 --json`.

### `providers list`

Syntax: `klopsi providers list`. Returns the registered `opsi` catalogue provider and `local` file resolver with their names, homepages, and declared capabilities. `--provider local` is for local paths and `local:file:` references; catalogue operations return a typed unsupported-capability error. This command works without DuckDB. Example: `klopsi providers list --json`.

## Files and data

### `download`

Syntax: `klopsi download <ids...> [--dataset|--resource] [--destination <path>|--output <path>] [--force]`. Canonical `provider:dataset:id` and `provider:resource:id` references are self-describing. Bare IDs require exactly one selector; dataset selection expands all embedded resources and an empty dataset exits 3. A directory receives sanitized provider filenames; a file path is valid for one selected resource. Each artifact and provenance sidecar is transactionally published without clobber races. Existing different content is not overwritten without `--force`. Partial batches exit 8. Examples: `klopsi download RESOURCE_ID --resource --output ./downloads --json` and `klopsi download opsi:dataset:DATASET_ID --output ./downloads`.

### `validate`

Syntax: `klopsi validate <input> [--metadata] [--sheet <name>] [--entry <path>] [--record-path <path>]`. Without `--metadata`, validates local/provider content; use `--sheet` for XLSX, `--entry` for ambiguous ZIP archives, and `--record-path` for ambiguous XML. With `--metadata`, input must be a canonical dataset/resource reference and only metadata is checked. The remote-content overrides `--allow-insecure-http` and `--allow-private-network` apply to content validation for one invocation. PC-Axis validation checks its dense cube, cardinalities, code lists, symbols, encoding, and hard limits; v1 `KEYS` input returns `PCAXIS_KEYS_UNSUPPORTED`, while an unsupported code page returns `PCAXIS_ENCODING_UNSUPPORTED`. Output includes issues, severities, and recommendations. Invalid data exits 6. Example: `klopsi validate ./downloads/traffic.csv --json`.

### `convert`

Syntax: `klopsi convert <input> --to <csv|tsv|json|ndjson|xlsx|parquet> --output <path> [options]`. Options include `--sheet`, `--entry`, `--record-path`, `--force`, `--spreadsheet-safe`, and network overrides. PC-Axis is accepted only as input; the converted long-form artifact preserves `__code`, `value`, and `value__symbol` semantics and receives the normal provenance sidecar. PC-Axis is not a `--to` choice. Publication is atomic. Example: `klopsi convert table.px --to parquet --output table.parquet`.

### `query`

Syntax: `klopsi query <input> (--sql <statement> | --sql-file <path|->) [--param <name[:type]=value>]... [options]`. Only one read-only SELECT, WITH…SELECT, or VALUES statement is accepted. Exactly one of `--sql` or `--sql-file` is required; giving neither or both exits 2 (`QUERY_SQL_REQUIRED` or a usage error). `--sql-file` reads one statement from a regular UTF-8 file (relative to the working directory) or from piped standard input with `-`; it is bounded to 1 MiB, strips one leading UTF-8 BOM, and rejects directories, FIFOs, devices, empty or whitespace-only SQL, and invalid UTF-8 with exit 2 (`QUERY_SQL_FILE_INVALID`, `QUERY_SQL_FILE_TOO_LARGE`, `QUERY_SQL_FILE_ENCODING`) or a missing file with exit 3 (`QUERY_SQL_FILE_NOT_FOUND`). The SQL size and read-only policy still apply to file SQL. Options include `--limit`, `--timeout-ms`, `--sheet`, `--entry`, `--record-path`, `--output`, `--force`, and network overrides.

Repeatable `--param name=value` binds a DuckDB `$name` placeholder through a prepared statement; values are never spliced into SQL text, so quotes or SQL fragments in a value are only data. Values are `varchar` by default; the typed form `name:type=value` supports `int` (signed 64-bit, bound as BIGINT), `double` (finite decimal, DOUBLE), `bool` (`true` or `false`, BOOLEAN), and `date` (`YYYY-MM-DD`, DATE). Names must match `[A-Za-z_][A-Za-z0-9_]*` (at most 63 characters) and are case-insensitive like DuckDB placeholders; at most 64 parameters of up to 64 KiB each are allowed. Malformed, mistyped, duplicate, or over-limit parameters exit 2 (`QUERY_PARAM_INVALID`, `QUERY_PARAM_DUPLICATE`, `QUERY_PARAM_LIMIT`). A placeholder without a value, a positional `?`/`$1` placeholder, or a supplied parameter the statement does not use exits 2 (`QUERY_PARAM_MISSING` with `context.missing`, `QUERY_PARAM_UNUSED` with `context.unused`); mixing named and positional placeholders exits 2 with `QUERY_PARAM_INVALID`. Bound text values are redacted from DuckDB error messages as `<param:name>`, but they are recorded verbatim in `meta.parameters` and export provenance, so do not pass secrets. Delimited input columns are VARCHAR, so compare typed parameters with a cast such as `CAST(value AS BIGINT) >= $min`. When parameters are bound, `meta.parameters` lists them as `{name,type,value}`. User SQL runs against KLOPSI-owned table `data` with row/time/memory/thread/cell/output bounds and external access disabled. Dense PC-Axis is staged as the same deterministic long form used by preview and conversion; quote non-ASCII or punctuation-bearing column names and filter source-symbol nulls with `value IS NULL` plus `value__symbol`. Query exports retain normal provenance; the `query` transformation records the executed `sql` and, when bound, its `parameters` so the export can be reproduced. Examples: `klopsi query table.px --sql 'select * from data where value is not null limit 2' --json` and `klopsi query traffic.csv --sql-file top-roads.sql --param region=Gorenjska --param min:int=1000 --output roads.csv --json`.

### `duckdb open`

Syntax: `klopsi duckdb open <input> [options]`. Resolves any tabular input accepted by `query`, including provider resources and local CSV, TSV, JSON, NDJSON, XLSX, Parquet, XML, dense PC-Axis, or ZIP selections, then opens its KLOPSI-owned relation `data` in DuckDB UI. PC-Axis uses the same label, `__code`, `value`, and `value__symbol` long form. Use `--sheet`, `--entry`, or `--record-path` to disambiguate compound inputs. DuckDB UI opens a writable invocation-local workbench; KLOPSI attaches the staged dataset to that workbench read-only and exposes `data` as a view. The lease remains live until DuckDB UI exits. Closing DuckDB UI releases and removes the invocation-local stage and workbench. The canonical derived cache remains immutable and reusable; the selected source and any adjacent provenance sidecar are not modified.

The external DuckDB CLI is optional. When it is unavailable, the command exits 5 with `DUCKDB_CLI_UNAVAILABLE`; add `--install` to explicitly authorize the official installer for that invocation. `--allow-insecure-http` and `--allow-private-network` retain their normal per-invocation remote-content meaning. Structured output reports the source, table name, CLI version, whether installation occurred, and stage-cache status after the UI closes. Example: `klopsi duckdb open ./downloads/data.csv`.

DuckDB UI is a local, full SQL exploration environment for browsing tables, summaries, and temporary charts. It is not the bounded `klopsi query` sandbox. Use `klopsi query` for reproducible, policy-bounded SQL and durable exports.

### `duckdb install`

Syntax: `klopsi duckdb install [--yes]`. Reports the existing external DuckDB CLI without changing it. When the CLI is absent, `--yes` is required to authorize DuckDB's official installer; otherwise the command exits 2 with `CONFIRMATION_REQUIRED`. Automatic installation is supported on Linux x64, macOS arm64, and Windows x64 and verifies that the pinned CLI is usable before success. Example: `klopsi duckdb install --yes`.

### `service inspect`

Syntax: `klopsi service inspect <resource>`. Inspects a canonical WFS resource and reports the negotiated service version, supported operations, output formats, and advertised layers. The remote-content overrides apply for one invocation. Example: `klopsi service inspect opsi:resource:ID --json`.

### `service layers`

Syntax: `klopsi service layers <resource>`. Lists the feature layers exposed by a canonical WFS resource. The remote-content overrides apply for one invocation. Example: `klopsi service layers opsi:resource:ID --json`.

### `service schema`

Syntax: `klopsi service schema <resource> --layer <name>`. Describes the fields and types for one feature layer. The remote-content overrides apply for one invocation. Example: `klopsi service schema opsi:resource:ID --layer si:roads --json`.

### `service preview`

Syntax: `klopsi service preview <resource> --layer <name> [options]`. `--limit` and nonnegative `--start-index` bound pagination. Repeatable/comma-separated `--property` selects fields, repeatable `--filter-eq field=value` applies typed equality filters, and `--bbox minx,miny,maxx,maxy` accepts an optional `--crs`. Raw CQL/XML filters are not supported. Example: `klopsi service preview opsi:resource:ID --layer si:roads --property id,name --limit 5 --json`.

### `service count`

Syntax: `klopsi service count <resource> --layer <name> [options]`. Repeatable `--filter-eq field=value` applies typed equality filters, and `--bbox minx,miny,maxx,maxy` accepts an optional `--crs`. The operation is read-only and does not accept raw CQL/XML filters. Example: `klopsi service count opsi:resource:ID --layer si:roads --filter-eq status=active --json`.

### `service export`

Syntax: `klopsi service export <resource> --layer <name> --output <path> [options]`. Exports bounded CSV rows using `--limit`, nonnegative `--start-index`, repeatable/comma-separated `--property`, typed `--filter-eq field=value`, `--bbox`, and `--crs`. Existing regular files require `--force`. Write transactions and raw CQL/XML filters are not supported. Example: `klopsi service export opsi:resource:ID --layer si:roads --limit 1000 --output roads.csv`.

### `provenance show`

Syntax: `klopsi provenance show <path>`. Reads the adjacent versioned provenance record for a downloaded/converted/query-exported artifact. Missing or malformed provenance exits 3 or 6. Example: `klopsi provenance show traffic.parquet --json`.

### `provenance verify`

Syntax: `klopsi provenance verify <path>`. Recomputes the artifact SHA-256 and compares the stored record. Mismatch/tampering exits 6. Example: `klopsi provenance verify traffic.parquet --json`.

## Local state

### `cache info`

Reports cache paths, object/metadata counts, total bytes, and separate DuckDB-derived object/byte/budget/TTL totals. Example: `klopsi cache info --json`.

### `cache list`

Lists cache objects without mutation, marking them `raw` or `duckdb-stage`; derived entries include format and retention timestamps but no source path, URL, SQL, or result rows. Example: `klopsi cache list --json`.

### `cache clear`

Deletes cache content with `--yes` or an interactive human confirmation. Non-TTY and structured-output use never prompt and exit 2 with `CONFIRMATION_REQUIRED`. Example: `klopsi cache clear --yes`.

### `cache prune`

Removes expired metadata and unreferenced objects with `--yes` or interactive human confirmation. Derived stages are expired first and then evicted by least-recent use until their separate budget is met. Raw cache entries are not evicted to meet that budget. Publication locks and valid live references are preserved. Example: `klopsi cache prune --yes --json`.

### `cache verify`

Re-hashes cached objects and structurally opens derived DuckDB stages read-only. Any corrupt object exits 6. Example: `klopsi cache verify --json`.

### `config get`

Syntax: `klopsi config get <dotted-key>`. Reads the persisted user source (not secret environment values). Example: `klopsi config get query.rowLimit --json`.

### `config set`

Syntax: `klopsi config set <dotted-key> <JSON-or-string>`. The complete strict source is validated and atomically written mode 0600. Secret-like keys are rejected. Example: `klopsi config set query.rowLimit 500`.

### `config list`

Lists persisted user configuration only. It does not print `OPSI_API_KEY`. Example: `klopsi config list --json`.

### `config path`

Returns platform user configuration and current project configuration paths. Example: `klopsi config path --json`.

## Diagnostics and shell integration

### `doctor`

Syntax: `klopsi doctor [--offline]`. Aggregates Node, configuration, writable cache/temp, connectivity (or deterministic skip), real DuckDB load/query, real CSV/TSV/JSON/NDJSON/XLSX/Parquet handler previews, and a separate real dense PC-Axis input probe. The PC-Axis check verifies zero-padded `__code` preservation and `value__symbol` handling without treating PC-Axis as an output format. Output is `{status,checks[]}` where each check is `pass`, `fail`, or `skip`. All checks run before failure. Native absence exits 5 as `DUCKDB_UNAVAILABLE`; connectivity failure exits 4; other failed checks exit 6. Example: `klopsi doctor --offline --json`.

### `completion`

Syntax: `klopsi completion <bash|zsh|fish>`. Prints a static script generated from the normalized command manifest. It completes only known commands/options/enum/provider values plus local filesystem paths and never calls OPSI. Install with `klopsi completion bash > ~/.local/share/bash-completion/completions/klopsi`, the corresponding zsh `$fpath` file, or `~/.config/fish/completions/klopsi.fish`.

### `generate-skills`

Syntax: `klopsi generate-skills [--output-dir <path>]`. Generates the complete installable Agent Skills repertoire for compatible AI-agent hosts. The default output directory is `./skills`; the `--output-dir` option accepts relative paths resolved from the current directory or absolute paths.

Generation is deterministic, idempotent, and offline. It creates the output and known skill directories as needed, atomically replaces only known generated files, including nested templates, references, and scripts, and preserves unrelated files. An existing non-directory or symbolic-link target is rejected with `SKILL_OUTPUT_INVALID`. Other filesystem failures return `SKILL_GENERATION_FAILED`. Normal structured output flags are supported; for example, `klopsi generate-skills --output-dir ~/.agents/skills --json` returns the resolved output directory, generated skill count, and skill names.

### `agent setup`

Syntax: `klopsi agent setup [--agent <ids...> | --all] [--yes] [--dry-run]`. Generates the current version's complete KLOPSI Agent Skills repertoire, including known nested templates, references, and scripts, in a private temporary directory; performs automatic agent detection from a registry synchronized with the pinned Agent Skills installer; then uses that installed runtime for global installation. KLOPSI passes only resolved, validated agent IDs with non-prompting confirmation and always copies skills durably because the generated source is temporary, so the installer cannot offer unrelated remote skills or leave targets dependent on cleanup. The temporary directory is removed after success or failure. The command does not run `npx`, fetch skills from GitHub, or create project-local `.agents` and `skills-lock.json` files.

In an interactive terminal, no selection flag is required: one detected host is selected automatically and multiple detected hosts require one KLOPSI confirmation. `--yes` accepts the detected set without prompting, `--agent <ids...>` chooses explicit validated installer IDs, and `--all` targets every profile in the pinned registry that supports global installation. If no host is detected, setup exits 2 with `AGENT_HOSTS_NOT_DETECTED`; `--yes` never turns that empty set into all profiles. `--agent` and `--all` conflict. `--dry-run` returns the installer version, global scope, requested selection, and generated skill names without creating a temporary directory, probing the host filesystem, or resolving the installer.

Non-interactive and structured-output invocations must use `--yes`, `--agent`, or `--all` unless they are dry runs; otherwise they exit 2 with `AGENT_SETUP_NONINTERACTIVE_REQUIRED`. Invalid, unknown, duplicate, or conflicting selections return `AGENT_SETUP_OPTIONS_INVALID`. Installer resolution failures return `AGENT_INSTALLER_UNAVAILABLE`; nonzero installer exits return `AGENT_SETUP_FAILED` with a bounded diagnostic. A zero-exit upstream result that reports failed targets becomes `AGENT_SETUP_PARTIAL` with exit 8. Normal structured output flags are supported; for example, `klopsi agent setup --agent codex --yes --json` installs without mixing installer decoration into stdout.

The default response is a sectioned human summary: previews state that no files changed, confirmation lists detected agent display names and the repertoire size, and successful installation reports targets, skill count, setup details, and next steps. Interactive terminals use restrained color unless `--no-color` or `NO_COLOR` disables it; redirected human output remains plain text. JSON, NDJSON, CSV, and TSV continue to use the stable structured result rather than the human document.
