# klopsi

**One CLI for Slovenian public data — built for people, scripts, and agents.**

Search Slovenia's [OPSI](https://podatki.gov.si/) catalogue, inspect and download resources, safely select ZIP/XML or dense PC-Axis input, query read-only WFS services, and analyze tabular data locally with DuckDB. Structured output, bounded operations, and built-in help make `klopsi` straightforward to use from a terminal, an automated workflow, or a coding agent.

[![CI](https://github.com/0xfa7ca7/klopsi/actions/workflows/ci.yml/badge.svg)](https://github.com/0xfa7ca7/klopsi/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/0xfa7ca7/klopsi/blob/main/LICENSE)

> [!IMPORTANT]
> `klopsi` is under active development. Expect breaking changes before v1.0.

## Why klopsi?

- **One end-to-end workflow.** Discover, inspect, download, validate, query, and convert public data without switching tools.
- **Predictable automation.** Choose JSON, NDJSON, CSV, or TSV output and branch on stable exit categories.
- **Agent-friendly interface.** Use built-in help, machine-readable results, bounded operations, and installable Agent Skills.
- **Safe local analysis.** Downloads are bounded and verified, queries are read-only and sandboxed, and generated artifacts include provenance records.
- **Useful offline.** Reuse cached catalogue metadata and content without accidental network requests.

## Installation

Requires Node.js 24 or later. Supported releases target Linux x64 with glibc, macOS arm64, and Windows x64.

```sh
npm install --global klopsi
klopsi --version
klopsi doctor --offline
```

KLOPSI's `@duckdb/node-api` binding is an optional native dependency. Catalogue, configuration, and completion commands remain available when a compatible binding cannot be installed; native data commands return `DUCKDB_UNAVAILABLE` with remediation guidance. The external DuckDB CLI is a separate optional dependency used only by `klopsi duckdb`.

For project-local use, run `npm install klopsi` and invoke the CLI with `npx klopsi`. See the [installation guide](https://github.com/0xfa7ca7/klopsi/blob/main/docs/installation.md) for release verification and troubleshooting.

Run bare `klopsi` for guided getting-started steps, example discovery commands, environment checks, and an invitation to install KLOPSI skills for detected AI agents. Use `klopsi --help` when you want the complete command reference instead.

## Quick start

Search the catalogue and inspect a dataset:

```sh
klopsi search promet --limit 5
klopsi dataset show DATASET_ID --json
klopsi dataset resources DATASET_ID
```

Download a returned resource, then preview, validate, and query it locally:

```sh
klopsi download opsi:resource:RESOURCE_ID --output ./downloads
klopsi resource preview ./downloads/data.csv --limit 10
klopsi validate ./downloads/data.csv --json
klopsi query ./downloads/data.csv \
  --sql "select * from data limit 10" \
  --json
```

Open the prepared table `data` in a DuckDB dataset workbench, optionally authorizing installation of the external CLI. The writable workbench is session-local, while KLOPSI attaches the staged source read-only:

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

Run `klopsi --help` or read the [complete command reference](https://github.com/0xfa7ca7/klopsi/blob/main/docs/commands.md) for every command, option, and exit category.

## Command overview

| Goal                          | Command                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| Search the catalogue          | `klopsi search [text]`                                          |
| Inspect a dataset             | `klopsi dataset show <id>`                                      |
| List dataset resources        | `klopsi dataset resources <id>`                                 |
| Inspect or preview a resource | `klopsi resource show <id>` / `klopsi resource preview <input>` |
| Download data                 | `klopsi download <ids...>`                                      |
| Validate data or metadata     | `klopsi validate <input>`                                       |
| Profile columns               | `klopsi profile <input>`                                        |
| Query tabular data            | `klopsi query <input> --sql <statement>`                        |
| Explore data in DuckDB UI     | `klopsi duckdb open <input>`                                    |
| Convert formats               | `klopsi convert <input> --to <format> --output <path>`          |
| Verify provenance             | `klopsi provenance verify <path>`                               |
| Diagnose the installation     | `klopsi doctor`                                                 |

## Using klopsi with agents

Install the complete [Agent Skills repertoire](https://github.com/0xfa7ca7/klopsi/blob/main/docs/skills.md) into automatically detected compatible agent hosts:

```sh
klopsi agent setup
```

Use `--yes` for unattended detected-host setup, `--agent <ids...>` for explicit hosts, `--all` for every globally installable profile, or `--dry-run` to preview the operation. An empty detection result fails safely instead of expanding `--yes` to every profile. Setup installs durable copies because its generated source is temporary.

Human setup output uses readable agent names and separate installed-skill, detail, and next-step sections. Interactive terminals receive restrained color; `NO_COLOR` and redirected output remain clean plain text. Structured output retains its stable automation-oriented data.

To refresh a stale repertoire, preview the exact target with `klopsi agent setup --agent <id> --dry-run --json`, then rerun without `--dry-run` after authorization. After a successful exit, confirm that structured output lists only the requested `agents` and the complete `skills` repertoire. Generate the same portable skill tree without installing it with `klopsi generate-skills --output-dir <directory>`.

The repertoire includes two agent-authored and contract-verified presentation workflows that create self-contained offline HTML from prepared local data. Install a focused static or interactive dashboard skill together with the shared presentation contract and verifier:

```sh
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-static-dashboard
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-interactive-dashboard
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-shared
```

For broad database representation and exploration, install the dataset workbench skill. It covers SQL, profiles, tables, charts, and an optional DuckDB UI notebook named `Example queries`:

```sh
npx skills add https://github.com/0xfa7ca7/klopsi/tree/main/skills/klopsi-dataset-workbench
```

This first version is agent-authored and contract-verified, not deterministically rendered by a CLI command. [Issue #28](https://github.com/0xfa7ca7/klopsi/issues/28) tracks the future deterministic CLI-backed renderer.

Agents use the same CLI as people and scripts. Prefer structured output and bounded results:

```sh
klopsi search promet --fields id,title --json --limit 5
klopsi resource preview ./downloads/data.csv --limit 20 --json
```

## TypeScript SDK

The dependency-clean `klopsi/sdk` entry point exports `KlopsiClient`, `ProviderRegistry`, and public domain types:

```ts
import { KlopsiClient, ProviderRegistry, type DataProvider } from "klopsi/sdk";

export function createClient(provider: DataProvider): KlopsiClient {
  const registry = new ProviderRegistry([provider]);
  return new KlopsiClient({ registry, providerId: provider.descriptor.id });
}
```

See [provider development](https://github.com/0xfa7ca7/klopsi/blob/main/docs/providers.md), [format development](https://github.com/0xfa7ca7/klopsi/blob/main/docs/formats.md), and [architecture](https://github.com/0xfa7ca7/klopsi/blob/main/docs/architecture.md) for extension contracts.

## Documentation

- [Command reference](https://github.com/0xfa7ca7/klopsi/blob/main/docs/commands.md)
- [Recipes](https://github.com/0xfa7ca7/klopsi/blob/main/docs/recipes.md)
- [Configuration](https://github.com/0xfa7ca7/klopsi/blob/main/docs/configuration.md)
- [Installation and troubleshooting](https://github.com/0xfa7ca7/klopsi/blob/main/docs/installation.md)
- [Security model](https://github.com/0xfa7ca7/klopsi/blob/main/docs/security.md)
- [Agent Skills](https://github.com/0xfa7ca7/klopsi/blob/main/docs/skills.md)

## License

[MIT](https://github.com/0xfa7ca7/klopsi/blob/main/LICENSE)
