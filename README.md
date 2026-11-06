# klopsi

_komandna linija za OPSI_

**built for people, scripts, and agents**

Search Slovenia's [OPSI](https://podatki.gov.si/) catalogue, inspect and download resources, safely select ZIP/XML data, query read-only WFS services, and analyze tabular data locally with DuckDB. Structured output, bounded operations, and built-in help make `klopsi` straightforward to use from a terminal, an automated workflow, or a coding agent.

[![CI](https://github.com/0xfa7ca7/klopsi/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfa7ca7/klopsi/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> [!IMPORTANT]
> `klopsi` is under active development. Expect breaking changes before v1.0.

## Contents

- [klopsi](#klopsi)
  - [Contents](#contents)
  - [Why klopsi?](#why-klopsi)
  - [Installation](#installation)
    - [Requirements](#requirements)
    - [Install from npm](#install-from-npm)
    - [Install from source](#install-from-source)
  - [Quick start](#quick-start)
  - [Command overview](#command-overview)
  - [Working with data](#working-with-data)
  - [Automation and structured output](#automation-and-structured-output)
  - [Using klopsi with agents](#using-klopsi-with-agents)
  - [Offline use](#offline-use)
  - [Security](#security)
  - [TypeScript SDK](#typescript-sdk)
  - [Documentation](#documentation)
  - [Development](#development)
  - [License](#license)

## Why klopsi?

- **One end-to-end workflow.** Discover a dataset, inspect its resources, download the data, validate it, query it, and convert it without switching tools.
- **Predictable automation.** Choose JSON, NDJSON, CSV, or TSV output; keep result data on stdout; and branch on stable exit categories.
- **Agent-friendly interface.** Discover commands with `--help`, request compact machine-readable results with `--json` and `--fields`, and handle failures without parsing human-readable messages.
- **Safe local analysis.** Downloads are bounded and verified, queries are read-only and sandboxed, and generated artifacts include provenance records.
- **Useful offline.** Reuse cached catalogue metadata and content without allowing accidental network requests.
- **Fast repeated queries.** Transparently reuse immutable DuckDB staging databases for unchanged content, with a separate TTL/LRU storage budget.

## Installation

### Requirements

- Node.js 24 or later
- Linux x64 with glibc, macOS arm64, or Windows x64 for supported releases

KLOPSI's `@duckdb/node-api` binding is an optional native dependency. Catalogue, configuration, and completion commands remain available when a compatible binding cannot be installed; native data commands return `DUCKDB_UNAVAILABLE` with remediation guidance. The external DuckDB CLI is a separate optional dependency used only by `klopsi duckdb`.

### Install from npm

Install the supported release globally:

```sh
npm install --global klopsi
```

Confirm the installation:

```sh
klopsi --version
klopsi doctor --offline
```

For project-local use, run `npm install klopsi` and invoke the CLI with `npx klopsi`.

### Install from source

To build the current source checkout instead:

```sh
git clone https://github.com/0xfa7ca7/klopsi.git klopsi
cd klopsi
corepack enable
corepack prepare pnpm@11.11.0 --activate
pnpm install --frozen-lockfile
pnpm build
npm install --global ./apps/cli
```

See the [installation guide](docs/installation.md) for supported targets, release verification, and troubleshooting.

Run bare `klopsi` for guided getting-started steps, example discovery commands, environment checks, and an invitation to install KLOPSI skills for detected AI agents. Use `klopsi --help` when you want the complete command reference instead.

## Quick start

Search the catalogue and inspect a dataset:

```sh
klopsi search promet --limit 5
klopsi dataset show DATASET_ID --json
klopsi dataset resources DATASET_ID
```

Replace `DATASET_ID` with an ID returned by `search`, then download one of its resources:

```sh
klopsi download opsi:resource:RESOURCE_ID --output ./downloads
```

Replace `RESOURCE_ID` with an ID returned by `dataset resources`. Use the downloaded filename to preview, validate, and query the data:

```sh
klopsi resource preview ./downloads/data.csv --limit 10
klopsi validate ./downloads/data.csv --json
klopsi query ./downloads/data.csv \
  --sql "select * from data limit 10" \
  --json
```

Open the same prepared table `data` in a DuckDB dataset workbench. The writable workbench is session-local, while KLOPSI attaches the staged source read-only. Install the external DuckDB CLI explicitly when it is not already available:

```sh
klopsi duckdb open ./downloads/data.csv
klopsi duckdb open ./results.parquet --install
klopsi duckdb install --yes
```

Convert the resource to Parquet and verify its provenance:

```sh
klopsi convert ./downloads/data.csv \
  --to parquet \
  --output ./downloads/data.parquet

klopsi provenance verify ./downloads/data.parquet --json
```

Run `klopsi --help` or read the [complete command reference](docs/commands.md) for every command, option, and exit category.

## Command overview

| Goal                          | Command                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Search the catalogue          | `klopsi search [text]`                                           |
| List datasets quickly         | `klopsi dataset list`                                            |
| Inspect a dataset             | `klopsi dataset show <id>`                                       |
| List dataset resources        | `klopsi dataset resources <id>`                                  |
| Inspect or preview a resource | `klopsi resource show <id>` / `klopsi resource preview <input>`  |
| Download data                 | `klopsi download <ids...>`                                       |
| Validate data or metadata     | `klopsi validate <input>`                                        |
| Query tabular data            | `klopsi query <input> --sql <statement> \| --sql-file <path\|->` |
| Explore data in DuckDB UI     | `klopsi duckdb open <input>`                                     |
| Convert formats               | `klopsi convert <input> --to <format> --output <path>`           |
| Verify provenance             | `klopsi provenance verify <path>`                                |
| Inspect local state           | `klopsi cache info` / `klopsi config list`                       |
| Diagnose the installation     | `klopsi doctor`                                                  |
| Generate shell completion     | `klopsi completion <bash\|zsh\|fish>`                            |
| Set up detected AI agents     | `klopsi agent setup`                                             |

`klopsi dataset list` reads a compact, centrally published catalogue snapshot by default. Use `--refresh` to check for a current snapshot or `--live` to query OPSI directly. The command never silently falls back to a live query. See the [catalogue service guide](docs/catalogue-service.md) for details.

## Working with data

`klopsi` can inspect and validate resilient CSV/TSV-style data (UTF-8/UTF-16, comma/tab/semicolon/pipe), JSON, NDJSON, XLSX, Parquet, bounded XML records, dense PC-Axis, and one safely selected data entry inside a ZIP. Dense PC-Axis is input-only and becomes bounded long-form rows that preserve dimension labels, zero-padded codes, numeric values, and source data symbols. Use `--entry` for ambiguous archives and `--record-path` for ambiguous XML. Read-only WFS workflows expose layers, schemas, bounded previews, counts, and CSV exports without leaving KLOPSI.

The first query or DuckDB UI session for a source imports it into a rebuildable DuckDB stage with one table named `data`; later operations over identical bytes and the same XLSX sheet reuse that stage. JSON metadata reports `cache.status` as `miss`, `hit`, or `bypass`. The derived cache defaults to a 10 GB budget and 30-day sliding lifetime, and its entries are visible through `klopsi cache info|list|verify|prune|clear`. Derived eviction never removes raw downloads or catalogue data merely to satisfy the DuckDB budget.

| Capability | Behavior                                                                        |
| ---------- | ------------------------------------------------------------------------------- |
| Preview    | Reads a bounded number of rows from local files or provider resources           |
| Validate   | Reports typed issues and recommendations for data or metadata                   |
| Query      | Accepts one bounded, read-only `SELECT`, `WITH … SELECT`, or `VALUES` statement |
| Convert    | Writes CSV, TSV, JSON, NDJSON, XLSX, or Parquet atomically                      |
| Provenance | Records and verifies the source, transformation, and SHA-256 digest             |

XLSX formulas are treated as data and are never executed. See [format support](docs/formats.md) for detection rules, limits, worksheet handling, and extension guidance.

## Automation and structured output

Human-readable tables are the interactive default. For scripts and pipelines, select `--json`, `--ndjson`, `--csv`, `--tsv`, or `--output-format`:

```sh
klopsi search promet --fields id,title --json --limit 5
klopsi dataset list --ndjson
NO_COLOR=1 klopsi providers list --csv
```

JSON responses use a stable `{ schemaVersion, data, meta, error? }` envelope. Query metadata includes the transparent DuckDB stage-cache status. Results go to stdout; warnings and diagnostics go to stderr. Stable exit categories let scripts distinguish invalid input, missing data, provider failures, validation errors, query failures, and partial success without parsing messages.

## Using klopsi with agents

The repository ships a complete repertoire of [Agent Skills](docs/skills.md): a main `klopsi` orchestrator, shared safety guidance, and focused skills for every command area. After installing the CLI, let KLOPSI detect supported agent hosts and install the complete repertoire globally:

```sh
klopsi agent setup
```

Interactive setup asks for confirmation when more than one host is detected. For unattended setup, accept the detected hosts with `--yes`, target explicit installer IDs with `--agent codex claude-code`, or target every globally installable profile with `--all`. If detection finds no host, choose one explicitly with `--agent` or `--all`; `--yes` never expands an empty detection result. Use `--dry-run` to preview the plan. Setup always copies skills durably into agent directories because its generated source is temporary. Setup uses the pinned installer shipped with KLOPSI, does not invoke `npx`, does not offer unrelated remote skills, and does not create `.agents` or `skills-lock.json` in the current project.

Human setup output uses clear detected-agent, installed-skill, detail, and next-step sections, with restrained color on interactive terminals and plain text under `NO_COLOR` or redirection. Structured output keeps the stable result shape for scripts and agents.

To refresh a stale repertoire, rerun `klopsi agent setup`; preview the intended update with `--dry-run`, choose a host with `--agent`, and verify that the installed host contains every skill reported by the structured setup output.

For a project-local installation, use a compatible Agent Skills installer directly:

```sh
npx skills add https://github.com/0xfa7ca7/klopsi
```

Or install only a focused skill and its `klopsi-shared` prerequisite:

```sh
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-analysis
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-dataset-workbench
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-shared
```

The dataset workbench skill represents prepared data as a database for SQL, profiles, tables, and charts. It can also offer to create a DuckDB UI notebook named `Example queries` through supported UI controls.

Prepared local data can be presented through two agent-authored and contract-verified workflow skills. Both create one self-contained offline HTML artifact: choose the static skill for a concise printable board or the interactive skill for bounded exploration across linked views. Install either focused workflow together with its shared contract and verifier:

```sh
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-static-dashboard
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-interactive-dashboard
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-shared
```

This first version is agent-authored and contract-verified; it does not claim deterministic HTML rendering by the CLI. [Issue #28](https://github.com/0xfa7ca7/klopsi/issues/28) tracks a future deterministic CLI-backed renderer.

Compatible agent hosts select `klopsi` automatically from your request. Depending on the host, you may also invoke the main orchestrator as `/klopsi`, `@klopsi`, or `$klopsi`; these are agent-host forms, not shell commands. The skills use the installed CLI and do not add a model runtime or provider dependency to `klopsi`.

An installed CLI can also generate the same repertoire into a directory without installing it:

```sh
klopsi generate-skills
klopsi generate-skills --output-dir ~/.agents/skills --json
```

Agents use the same command surface as people and scripts. They should start with `--help`, request structured output, and keep results focused with field and row limits:

```sh
klopsi --help
klopsi search promet --fields id,title --json --limit 5
klopsi dataset show DATASET_ID --json
klopsi resource preview ./downloads/data.csv --limit 20 --json
```

For reliable agent workflows:

- Prefer `--json` or `--ndjson` over parsing human-readable tables.
- Use `--fields` and command-specific limits to keep context small and predictable.
- Read results from stdout, diagnostics from stderr, and use the process exit status for control flow.
- Pass `--offline` when the agent must not make network requests.
- Run `klopsi <command> --help` to inspect available arguments before constructing a command.

## Offline use

Warm the cache during an online run, then pass `--offline` or set `KLOPSI_OFFLINE=1`:

```sh
klopsi dataset list --refresh --json
klopsi dataset list --offline --json
KLOPSI_OFFLINE=1 klopsi resource preview opsi:resource:RESOURCE_ID --json
```

Offline commands never make network requests. Operations that require uncached metadata or content fail with a typed cache-miss error. Catalogue snapshots must remain valid and no more than 24 hours old.

## Security

Remote content is subject to HTTPS, DNS, redirect, timeout, and download-size controls. Bounded `klopsi query` operations run with DuckDB external access and extension loading disabled. DuckDB UI is an explicitly launched local exploratory environment and is outside that query sandbox; KLOPSI opens a writable invocation-local workbench with the staged dataset attached read-only. Downloads, conversions, and query exports publish atomically and record provenance.

Read the [security model](docs/security.md) and [security policy](SECURITY.md) before enabling network overrides or reporting a vulnerability.

## TypeScript SDK

The dependency-clean `klopsi/sdk` entry point exports `KlopsiClient`, `ProviderRegistry`, and public domain types. Supply a provider that implements the public `DataProvider` contract:

```ts
import { KlopsiClient, ProviderRegistry, type DataProvider } from "klopsi/sdk";

export function createClient(provider: DataProvider): KlopsiClient {
  const registry = new ProviderRegistry([provider]);
  return new KlopsiClient({
    registry,
    providerId: provider.descriptor.id,
  });
}
```

Provider and format extension contracts are documented in [provider development](docs/providers.md), [format development](docs/formats.md), and [architecture](docs/architecture.md).

## Documentation

- [Command reference](docs/commands.md)
- [Recipes](docs/recipes.md)
- [Configuration](docs/configuration.md)
- [Installation and troubleshooting](docs/installation.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)
- [Provider development](docs/providers.md)
- [Format development](docs/formats.md)
- [Release process](docs/releases.md)

## Development

This repository is a pnpm monorepo. Use Node.js 24 and pnpm 11.11.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Normal tests use local fixtures and do not contact OPSI.

## License

[MIT](LICENSE)
