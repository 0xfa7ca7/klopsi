import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { EXIT_CODES, KlopsiError } from "@klopsi/domain";
import {
  COMMAND_MANIFEST,
  GLOBAL_OPTION_MANIFEST,
  type CommandManifestEntry,
  type CommandOptionManifest,
} from "./command-manifest.js";
import { resourcesForAgentSkill } from "./agent-skill-resources.js";

export type AgentSkillKind = "router" | "shared" | "command" | "workflow";

export interface AgentSkillPackage {
  readonly name: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface AgentSkillCapabilityGuide {
  readonly id: string;
  readonly title: string;
  readonly instructions: readonly string[];
}

export interface AgentSkillDefinition {
  readonly kind: AgentSkillKind;
  readonly name: string;
  readonly description: string;
  readonly commands: readonly string[];
  readonly purpose: string;
  readonly workflows: readonly string[];
  readonly capabilities: readonly AgentSkillCapabilityGuide[];
  readonly safety: readonly string[];
  readonly related: readonly string[];
}

export const AGENT_SKILLS: readonly AgentSkillDefinition[] = [
  {
    kind: "router",
    name: "klopsi",
    description:
      "Use when a Slovenian public-data, OPSI catalogue, or KLOPSI CLI request needs the relevant skill selected.",
    commands: [],
    purpose:
      "Classify the request, load shared guidance, and select the smallest relevant domain skill or ordered set of skills.",
    workflows: [
      "Acquire and analyze data",
      "Inspect and export WFS data",
      "Represent and explore a dataset in a database workbench",
      "Analyze and present data",
      "Refresh an agent installation",
    ],
    capabilities: [],
    safety: [],
    related: [
      "klopsi-catalogue",
      "klopsi-resources",
      "klopsi-download",
      "klopsi-validation",
      "klopsi-analysis",
      "klopsi-dataset-workbench",
      "klopsi-services",
      "klopsi-provenance",
      "klopsi-static-dashboard",
      "klopsi-interactive-dashboard",
      "klopsi-local-state",
      "klopsi-diagnostics",
    ],
  },
  {
    kind: "shared",
    name: "klopsi-shared",
    description:
      "Use when any KLOPSI CLI skill needs shared installation, output, offline, safety, or error-handling guidance.",
    commands: [],
    purpose: "Provide the common execution contract every KLOPSI domain skill must follow.",
    workflows: [
      "Resolve the input, inspect it, preview a bounded sample, validate when useful, perform the requested operation, then verify important artifacts.",
    ],
    capabilities: [],
    safety: [
      "Prefer structured output and bounded result sets.",
      "Honor offline requests and existing network safeguards.",
      "Confirm destructive or overwrite operations unless already explicitly authorized.",
      "Do not fall back to curl or another raw HTTP client for an operation supported by klopsi.",
    ],
    related: [],
  },
  {
    kind: "command",
    name: "klopsi-catalogue",
    description:
      "Use when discovering Slovenian public-data or OPSI datasets, metadata, resources, schemas, or public pages.",
    commands: [
      "search",
      "dataset list",
      "dataset show",
      "dataset resources",
      "dataset schema",
      "dataset open",
    ],
    purpose: "Find datasets and inspect their normalized metadata and tabular schemas.",
    workflows: [
      "Search with a narrow limit and fields, then inspect the selected dataset.",
      "List dataset resources before selecting one for preview or download.",
    ],
    capabilities: [
      {
        id: "catalogue-mode",
        title: "Choose catalogue mode",
        instructions: [
          "Use the published snapshot for ordinary discovery; use `dataset list --refresh` only when a fresh snapshot is needed.",
          "Use `dataset list --live` for an explicit paginated live traversal, and do not combine it with `--refresh`.",
        ],
      },
      {
        id: "search-refinement",
        title: "Refine discovery",
        instructions: [
          "Start with `search` using `--limit`, `--fields`, and only the relevant organization, tag, format, license, date, or sort filters.",
          "Use `--all` only when every result page is required; otherwise retain a bounded page and exact IDs returned by the CLI.",
        ],
      },
      {
        id: "dataset-followup",
        title: "Follow a selected dataset",
        instructions: [
          "Run `dataset show`, then `dataset resources` before choosing a resource; use `dataset schema` when tabular structure determines the choice.",
          "Use `dataset open` only to view the provider's public page, not as a replacement for structured CLI metadata.",
        ],
      },
    ],
    safety: ["Use explicit live catalogue traversal only when the user needs it."],
    related: ["klopsi-resources", "klopsi-download", "klopsi-validation"],
  },
  {
    kind: "command",
    name: "klopsi-resources",
    description:
      "Use when inspecting an OPSI resource, its secure access, headers, or bounded preview before the next step.",
    commands: ["resource show", "resource inspect", "resource headers", "resource preview"],
    purpose: "Inspect a resource safely without committing to a full data workflow.",
    workflows: [
      "Inspect metadata and headers before downloading an unfamiliar resource.",
      "Preview a bounded number of rows before validation or analysis.",
    ],
    capabilities: [
      {
        id: "input-resolution",
        title: "Resolve the input",
        instructions: [
          "Use a local path for local data and retain an exact `opsi:resource:` reference for provider data; do not invent either identifier.",
          "Run `resource inspect` to learn supported access operations before choosing download, validation, WFS, or analysis.",
        ],
      },
      {
        id: "access-selection",
        title: "Select safe access",
        instructions: [
          "Use `resource headers` for a secure provider-header probe and `resource preview` with a small `--limit` for a bounded content check.",
          "Route a WFS resource to the services skill after inspection; do not replace KLOPSI access controls with direct HTTP.",
        ],
      },
      {
        id: "structured-selectors",
        title: "Resolve structured content",
        instructions: [
          "Use one `--entry` or `--record-path` reported by resource inspect or the relevant operation's structured error/output; resource inspect can surface ZIP entries and XML record paths.",
          "Without `--sheet`, XLSX resource preview, validate, or query emits `SHEET_REQUIRED` with `context.sheets` and a suggestion; use one listed sheet.",
        ],
      },
      {
        id: "pcaxis-preview",
        title: "Interpret PC-Axis previews",
        instructions: [
          "Dense PC-Axis preview emits deterministic long-form rows: each STUB or HEADING dimension becomes a label column, and a sibling `<dimension>__code` column appears when source CODES exist.",
          "Treat `__code` values as strings so zero-padded identifiers survive. A source data symbol produces `value: null` plus `value__symbol`; numeric zero remains `value: 0` without a symbol.",
        ],
      },
    ],
    safety: ["Keep previews bounded and do not weaken network controls implicitly."],
    related: ["klopsi-catalogue", "klopsi-download", "klopsi-validation", "klopsi-analysis"],
  },
  {
    kind: "command",
    name: "klopsi-download",
    description:
      "Use when securely downloading an OPSI dataset or resource and choosing a destination or overwrite handling.",
    commands: ["download"],
    purpose: "Download selected provider resources through the CLI's bounded secure downloader.",
    workflows: ["Resolve a canonical resource or dataset reference, then download it."],
    capabilities: [
      {
        id: "target-resolution",
        title: "Resolve download targets",
        instructions: [
          "Pass canonical resource references when available; use `--dataset` or `--resource` to disambiguate bare identifiers.",
          "Inspect a selected resource first when its format or access method is uncertain.",
        ],
      },
      {
        id: "destination-strategy",
        title: "Choose a destination",
        instructions: [
          "For a batch, `--destination` or `--output` must name an existing directory; a file destination is valid for one resource only.",
          "Otherwise use the configured download directory; do not use `--force` to replace an existing artifact unless that exact overwrite is authorized, and verify the existing artifact first when it matters.",
        ],
      },
      {
        id: "partial-results",
        title: "Handle batch results",
        instructions: [
          "For a batch, report each successful and failed resource separately; exit 8 means Partial success, not complete success.",
          "Run `provenance verify` for important downloaded artifacts before handing them to later workflow steps.",
        ],
      },
    ],
    safety: ["Confirm before replacing an existing artifact with --force."],
    related: ["klopsi-catalogue", "klopsi-resources", "klopsi-validation", "klopsi-provenance"],
  },
  {
    kind: "command",
    name: "klopsi-validation",
    description:
      "Use when checking local or provider data, or OPSI metadata, for integrity issues and remediation.",
    commands: ["validate"],
    purpose: "Validate data content or normalized metadata and explain actionable issues.",
    workflows: ["Validate downloaded content before analysis or conversion."],
    capabilities: [
      {
        id: "validation-mode",
        title: "Choose validation mode",
        instructions: [
          "Validate a local path or canonical provider reference before analysis; use `--metadata` when only normalized metadata should be checked.",
          "Use offline validation after acquisition when all required input is local; do not silently retry a failed offline request online.",
        ],
      },
      {
        id: "structured-selectors",
        title: "Select structured data",
        instructions: [
          "Use one `--entry` or `--record-path` reported by resource inspect or the relevant operation's structured error/output; resource inspect can surface ZIP entries and XML record paths.",
          "Without `--sheet`, XLSX resource preview, validate, or query emits `SHEET_REQUIRED` with `context.sheets` and a suggestion; use one listed sheet.",
        ],
      },
      {
        id: "failure-recovery",
        title: "Recover from validation failures",
        instructions: [
          "Treat exit 6 as a validation or integrity failure: report the issues and repair, replace, or reselect the input before retrying.",
          "Do not treat validation or integrity failure as a transient network error or bypass it before analysis.",
          "PC-Axis v1 supports dense DATA only: `KEYS` fails explicitly with `PCAXIS_KEYS_UNSUPPORTED`, and code pages other than windows-1250 or utf-8 fail with `PCAXIS_ENCODING_UNSUPPORTED`.",
        ],
      },
    ],
    safety: ["Treat integrity failures as non-retryable until the input changes."],
    related: ["klopsi-resources", "klopsi-download", "klopsi-analysis"],
  },
  {
    kind: "command",
    name: "klopsi-analysis",
    description:
      "Use when profiling, querying, or converting bounded data, including ZIP, XML, JSON, XLSX, Parquet, or query exports.",
    commands: ["profile", "query", "convert"],
    purpose:
      "Profile columns, analyze tabular inputs with bounded read-only SQL, or convert supported formats.",
    workflows: [
      "Preview and validate input, then run `klopsi profile` to learn column types, nulls, and ranges before writing a bounded query.",
      "Convert an input and then verify the generated provenance record.",
    ],
    capabilities: [
      {
        id: "supported-inputs",
        title: "Choose a supported input",
        instructions: [
          "Query or convert CSV, TSV, JSON, NDJSON, XLSX, Parquet, ZIP, XML, or dense PC-Axis only after inspection identifies usable tabular content.",
          "Use a resolved `--entry`, `--record-path`, or `--sheet` whenever ZIP, XML, or XLSX input is ambiguous.",
          "PC-Axis is input-only: convert it to CSV, TSV, JSON, NDJSON, XLSX, or Parquet, never to PC-Axis.",
          "In staged PC-Axis rows, keep `__code` fields as strings and interpret a source-symbol null as `value IS NULL` with the original token in `value__symbol`; do not confuse it with numeric zero.",
        ],
      },
      {
        id: "column-profile",
        title: "Profile columns before querying",
        instructions: [
          "Run `klopsi profile <input> --json` to get one row per staged column with `type`, `count`, `nullCount`, `nullPercent`, `distinctApprox`, `min`, `max`, and numeric `mean` and `stddev`.",
          "Use the reported column names and DuckDB types to write correctly quoted SQL; `min` and `max` are text so large integers stay exact, capped at 256 characters with `minTruncated`/`maxTruncated` flags, and `distinctApprox` is an estimate.",
          "For FLOAT and DOUBLE columns, `mean` and `stddev` exclude NaN, infinities, and magnitudes of 1e150 or more; query those values directly when they matter.",
          "Profile shares query staging, cache, and time, memory, and thread bounds; it accepts the same `--sheet`, `--entry`, and `--record-path` selectors and fails with exit 7 on timeout or cancellation.",
        ],
      },
      {
        id: "bounded-query",
        title: "Run bounded read-only SQL",
        instructions: [
          "Use one read-only `SELECT`, `WITH ... SELECT`, or `VALUES` statement, with an explicit `--limit` and a suitable timeout.",
          "Keep global query row, time, memory, and thread bounds appropriate to the requested result; correct exit 7 rather than retrying the same query.",
        ],
      },
      {
        id: "query-export",
        title: "Export query results",
        instructions: [
          "Use `--output` for a bounded query export and choose a new path unless the user explicitly authorizes `--force`.",
          "Run `provenance verify` on an important query export before reporting it as a final artifact.",
        ],
      },
      {
        id: "safe-conversion",
        title: "Convert safely",
        instructions: [
          "Choose a supported conversion target and `--output`; use `--spreadsheet-safe` for CSV or XLSX intended for spreadsheet software.",
          "Validate or inspect the converted result and use `provenance verify`; do not overwrite an existing destination without authorization.",
        ],
      },
    ],
    safety: [
      "Keep SQL read-only and bounded.",
      "Confirm before replacing an existing output with --force.",
    ],
    related: ["klopsi-resources", "klopsi-validation", "klopsi-provenance"],
  },
  {
    kind: "command",
    name: "klopsi-dataset-workbench",
    description:
      "Use when acquired or computed Slovenian public data should be represented as an explorable database with SQL, profiles, tables, charts, or an Example queries notebook.",
    commands: ["duckdb open", "duckdb install"],
    purpose:
      "Represent a resolved tabular dataset as the read-only `data` relation in a writable local database workbench.",
    workflows: [
      "Inspect or validate the selected input, verify important artifact provenance, then represent it as the `data` relation in a database workbench.",
      "Offer a dataset-specific `Example queries` notebook for guided exploration when supported UI control is available.",
      "Use an existing DuckDB CLI when available and install it only after explicit authorization.",
      "Move reproducible results back through bounded KLOPSI query exports or a durable HTML dashboard workflow.",
    ],
    capabilities: [
      {
        id: "representation-fit",
        title: "Choose a database workbench",
        instructions: [
          "Use this skill when acquired or computed data should be represented as an explorable database for iterative SQL, profiling, tables, summaries, charts, or guided example queries.",
          "Do not treat a UI session as the final artifact when the user needs a reproducible export, a self-contained presentation, or a result that another person can open without DuckDB.",
        ],
      },
      {
        id: "open-workbench",
        title: "Open the dataset workbench",
        instructions: [
          "Prefer a verified downloaded, converted, WFS-exported, or query-exported local artifact; use `--entry`, `--record-path`, or `--sheet` when the selected ZIP, XML, or XLSX input requires it.",
          "Run `klopsi duckdb open <input>` and query the workbench table `data`. KLOPSI opens a writable session-local workbench with the staged dataset attached read-only, then removes both invocation-local databases after DuckDB UI exits.",
          "DuckDB UI is an attached local SQL environment, not the bounded read-only SQL sandbox provided by `klopsi query`; keep untrusted SQL and extensions out of the session.",
        ],
      },
      {
        id: "example-queries",
        title: "Offer an Example queries notebook",
        instructions: [
          "Offer to create a notebook named `Example queries`. If the user accepts and supported UI control is available, create it through DuckDB UI controls with a small dataset-specific set of titled, read-only SQL cells.",
          "Choose only useful cells: preview and schema orientation, coverage or completeness, latest values or top categories, trends or period-over-period changes, and missing-period, duplicate, or null checks.",
          "Do not write private DuckDB UI storage tables, and never claim the notebook was created unless the supported UI action succeeded. If UI control is unavailable, present the proposed numbered queries for the user to paste.",
        ],
      },
      {
        id: "optional-installation",
        title: "Authorize optional installation",
        instructions: [
          "Use the already installed external DuckDB CLI when available. If it is absent, request explicit authorization before `klopsi duckdb install --yes` or `klopsi duckdb open <input> --install`.",
          "Do not infer installation consent from a request to inspect data, and do not run the official installer when the user requires offline execution.",
        ],
      },
      {
        id: "handoff",
        title: "Present the open workbench",
        instructions: [
          "Use this final-response section order: `DuckDB dataset workbench`, `Open workbench`, `Dataset`, `Checks`, `Example queries`, `Sources`.",
          "Place the local URL immediately under `Open workbench`. Show compact dataset facts such as title, relation, rows, coverage, measures, and columns; then report validation, provenance, and attached read-only status.",
          "Report the `Example queries` notebook as created, offered, or unavailable and list its numbered query topics. End with source and transformation files plus a note that the writable workbench is session-local.",
        ],
      },
      {
        id: "preserve-results",
        title: "Preserve reproducible results",
        instructions: [
          "For a reproducible computed artifact, rerun the final bounded SQL through `klopsi query --output <path>` and verify its provenance rather than relying on UI-only state.",
          "Use `klopsi-static-dashboard` for a concise static HTML board or `klopsi-interactive-dashboard` for a self-contained interactive HTML presentation; those durable workflows are distinct from temporary DuckDB UI charts.",
        ],
      },
    ],
    safety: [
      "Install the external DuckDB CLI only after explicit authorization.",
      "Do not describe DuckDB UI SQL as KLOPSI's bounded query sandbox.",
      "Create notebooks only through supported UI controls and report their status accurately.",
      "Do not claim durable provenance for temporary UI state or charts.",
    ],
    related: ["klopsi-analysis", "klopsi-static-dashboard", "klopsi-interactive-dashboard"],
  },
  {
    kind: "command",
    name: "klopsi-services",
    description:
      "Use when Slovenian public data is exposed through WFS and the request needs capabilities, layers, schemas, bounded feature previews, counts, or CSV exports.",
    commands: [
      "service inspect",
      "service layers",
      "service schema",
      "service preview",
      "service count",
      "service export",
    ],
    purpose: "Access WFS feature services through bounded, schema-validated KLOPSI workflows.",
    workflows: [
      "Inspect a canonical WFS resource, list layers, then inspect a selected layer schema.",
      "Preview or count a layer with typed equality filters before exporting bounded rows.",
    ],
    capabilities: [
      {
        id: "wfs-sequence",
        title: "Inspect the WFS service and layer",
        instructions: [
          "Keep the exact canonical `opsi:resource:` reference returned by KLOPSI; run `service inspect`, then `service layers`, then `service schema --layer <name>` before selecting features.",
          "Use the layer schema to choose a layer and its available fields; do not infer feature bounds or paging support from service inspection metadata.",
        ],
      },
      {
        id: "feature-selection",
        title: "Select fields and matching features",
        instructions: [
          "Use a small `service preview` before export; `--property` may repeat or take a comma-separated list to select the fields to return.",
          "Use `--filter-eq <field=value>` for typed lexical equality: values are coerced as booleans, numbers, or strings, not schema-aware XSD coercion.",
          "Use `service count` to measure the filtered selection before choosing an export limit.",
        ],
      },
      {
        id: "spatial-filtering",
        title: "Constrain space and pagination",
        instructions: [
          "Use `--bbox <minx,miny,maxx,maxy>` for a spatial extent, and `--crs <name>` must name the coordinate reference system used for the bbox.",
          "When paging, `--start-index` is zero-based; keep each preview or export bounded with a finite `--limit`.",
        ],
      },
      {
        id: "bounded-export",
        title: "Export and verify a bounded result",
        instructions: [
          "After previewing or counting the selection, use `service export` with a finite `--limit`; export output is CSV only.",
          "Choose a new output path unless the user gives `--force` after explicit overwrite authorization, then run `provenance verify` on an important exported artifact.",
        ],
      },
    ],
    safety: [
      "Use canonical resource references and bounded limits.",
      "Never send transaction requests, raw CQL, arbitrary XML filters, or direct HTTP calls.",
    ],
    related: ["klopsi-catalogue", "klopsi-resources", "klopsi-analysis", "klopsi-provenance"],
  },
  {
    kind: "command",
    name: "klopsi-provenance",
    description:
      "Use when inspecting or verifying KLOPSI artifact provenance, transformations, or integrity mismatches.",
    commands: ["provenance show", "provenance verify"],
    purpose: "Inspect recorded lineage and verify an artifact against its digest.",
    workflows: ["Verify every important downloaded, converted, or query-exported artifact."],
    capabilities: [
      {
        id: "record-inspection",
        title: "Inspect recorded lineage",
        instructions: [
          "Use `provenance show` to inspect an artifact's source, retrieval, and transformation record before explaining where it came from.",
          "Compare the record with the exact local artifact and preserve canonical references returned by KLOPSI.",
        ],
      },
      {
        id: "integrity-verification",
        title: "Verify artifact integrity",
        instructions: [
          "Use `provenance verify` to recompute and compare the artifact digest after download, conversion, or query export.",
          "Report a digest mismatch as integrity failure; Do not mutate, replace, or discard the evidence before it is reported.",
        ],
      },
    ],
    safety: ["Do not dismiss a digest mismatch or mutate evidence before reporting it."],
    related: ["klopsi-download", "klopsi-analysis"],
  },
  {
    kind: "workflow",
    name: "klopsi-static-dashboard",
    description:
      "Use when prepared Slovenian public data needs a concise static HTML dashboard, presentation board, printable visual summary, chart panel, heatmap, ranked list, or offline map.",
    commands: [],
    purpose:
      "Turn a prepared local artifact into a self-contained semantic HTML and inline-SVG board that remains useful offline and without JavaScript.",
    workflows: [
      "Confirm presentation preferences, verify the prepared source, select honest encodings, copy the static template to a new HTML destination, replace every marker, embed the presentation manifest, verify the board, and hand off its absolute path.",
    ],
    capabilities: [
      {
        id: "presentation-preflight",
        title: "Confirm presentation preferences",
        instructions: [
          "Before creating HTML, ask one compact checkpoint for the preferred language (English or Slovenian), color treatment (color-rich or restrained), and one to three additional data-specific questions that materially affect scope, comparison, audience, or emphasis.",
          "Do not create or copy the HTML template until the user answers. Do not choose defaults. Skip a language or color question only when the user explicitly names a supported choice; `use your judgment`, `make sensible choices`, urgency, or a request not to ask are not answers. Ask only the missing data-specific items.",
        ],
      },
      {
        id: "input-readiness",
        title: "Verify and prepare the source",
        instructions: [
          "Read `../klopsi-shared/references/presentation-contract.md`. Start from a prepared local artifact and retain its exact identity and SHA-256 digest. Check for `<artifact>.provenance.json`; when it exists, run `klopsi provenance verify <artifact> --json` and stop on failure. When it does not exist, mark the source `verified: false` without inventing lineage.",
          "Route validation failures to `klopsi-validation`, reshaping or aggregation to `klopsi-analysis`, and bounded WFS selection or export to `klopsi-services` before presentation. Do not silently truncate, guess units, relabel measures, or hide missing-data and source limitations.",
        ],
      },
      {
        id: "encoding-selection",
        title: "Choose evidence-matched encodings",
        instructions: [
          "Read `references/encoding-guide.md`; select each view from its analytical question and record its question, population, unit, relevant count, and plain-language takeaway in both the board and manifest.",
          "Create a map only from valid embedded coordinates or geometry with a known CRS. Never invent outlines, positions, boundaries, or a CRS; use a ranked list, bars, or a semantic table when spatial prerequisites are absent.",
        ],
      },
      {
        id: "board-composition",
        title: "Compose the static board",
        instructions: [
          "Copy `assets/static-board.html` to a new destination; do not overwrite an existing file without authorization. Replace every `{{MARKER}}` with escaped, data-grounded content, and remove optional sections entirely instead of leaving markers.",
          "Use the selected language for every visible label, control, note, table heading, accessibility description, and the document `lang` value. Use a subject-specific title and omit generic format labels such as `Static evidence board`, `dashboard`, or `report` unless the user explicitly requests one.",
          "For a color-rich presentation, use the template's named palette and distinct `accent-*` classes across KPI and view cards. For a restrained presentation, omit decorative `accent-*` variety and keep one primary data accent plus neutral structure. In both versions, keep labels, position, length, patterns, or symbols so color is never the only signal.",
          "Keep three to five KPI cards, two to six complementary view cards, adjacent interpretation, a semantic exact-values table, visible disclosures, and lineage. Preserve script-like source strings as text and never concatenate them into markup.",
          "Write exactly one inert `klopsi-presentation-manifest` JSON block. Escape every less-than character as `\\u003c`, describe all transformations and ordered reductions, and keep visible disclosures consistent with the manifest. For a non-map board, set `embeddedBytes` to `0` and omit presentation data. For a spatial board, add one inert `klopsi-presentation-data` block containing only the validated map rows and set its exact bytes and count in the manifest.",
        ],
      },
      {
        id: "verification",
        title: "Verify and hand off",
        instructions: [
          "Keep the result one self-contained offline HTML file with inline styles and SVG only: no executable JavaScript, CDN, remote font, image, tile, stylesheet, script, API, or companion data file.",
          "Respect the 15 MB HTML limit and the shared 5 MB embedded-data and 10,000-row interactive limits. Static mode uses no executable JavaScript. It embeds aggregate display values in semantic HTML or SVG; only a valid spatial view may also use the inert spatial presentation-data evidence required by the shared contract. Do not silently truncate; disclose every aggregation, projection, exclusion, or sample.",
          "Run `node ../klopsi-shared/scripts/verify-dashboard.mjs <dashboard.html> --mode static --json`, repair every finding, then review rendered chart marks, legends, heatmap cells, reading order, responsive layout, and grayscale print output before handing off the absolute HTML path with the verifier JSON and source-verification status.",
        ],
      },
    ],
    safety: [
      "Do not claim provenance from a presentation-verifier pass; use `provenance verify` for provenance claims.",
      "Do not fabricate geography, units, precision, causal claims, verification, or lineage.",
    ],
    related: ["klopsi-analysis", "klopsi-services", "klopsi-provenance"],
  },
  {
    kind: "workflow",
    name: "klopsi-interactive-dashboard",
    description:
      "Use when prepared Slovenian public data needs a self-contained interactive HTML dashboard with filters, linked charts, maps, heatmaps, search, sorting, drill-down, or exploratory detail.",
    commands: [],
    purpose:
      "Turn a bounded prepared local artifact into one offline exploratory HTML file whose useful initial overview and linked interactions share a single in-memory data flow.",
    workflows: [
      "Confirm presentation preferences, verify and bound the prepared source, copy the interactive template to a new HTML destination, replace every marker, embed safe normalized data and the presentation manifest, verify the dashboard, and hand off its absolute path.",
    ],
    capabilities: [
      {
        id: "presentation-preflight",
        title: "Confirm presentation preferences",
        instructions: [
          "Before creating HTML, ask one compact checkpoint for the preferred language (English or Slovenian), color treatment (color-rich or restrained), and one to three additional data-specific questions that materially affect scope, comparison, audience, or emphasis.",
          "Do not create or copy the HTML template until the user answers. Do not choose defaults. Skip a language or color question only when the user explicitly names a supported choice; `use your judgment`, `make sensible choices`, urgency, or a request not to ask are not answers. Ask only the missing data-specific items.",
        ],
      },
      {
        id: "input-readiness",
        title: "Verify and prepare the source",
        instructions: [
          "Read `../klopsi-shared/references/presentation-contract.md`. Start from a prepared local artifact and retain its exact identity and SHA-256 digest. Check for `<artifact>.provenance.json`; when it exists, run `klopsi provenance verify <artifact> --json` and stop on failure. When it does not exist, mark the source `verified: false` without inventing lineage.",
          "Route invalid input to `klopsi-validation`, reshaping or aggregation to `klopsi-analysis`, and bounded WFS selection or export to `klopsi-services`. Create a map only from valid embedded coordinates or geometry with a known CRS; otherwise choose a non-map view.",
        ],
      },
      {
        id: "bounded-embedding",
        title: "Bound and disclose embedded presentation data",
        instructions: [
          "Normalize the prepared rows to JSON and measure the exact UTF-8 presentation-data script body before authoring. Block when it exceeds 10,000 rows, 5 MB, or would make the complete HTML exceed 15 MB; never use a companion file, live query, or browser file picker to evade these limits.",
          "Do not silently truncate. Return to `klopsi-analysis` or `klopsi-services` for a deliberate aggregation, projection, or bounded selection. Use sampling only when aggregation cannot answer the question and ask first when it could change interpretation. Record and visibly disclose original and presented counts, method, grouping fields, exclusions, sample basis, and interpretive impact.",
        ],
      },
      {
        id: "initial-overview",
        title: "Compose a useful initial overview",
        instructions: [
          "Read `references/interaction-guide.md`. Copy `assets/interactive-dashboard.html` to a new destination without overwriting an existing file without authorization, replace every `{{MARKER}}`, and remove optional sections rather than leaving markers.",
          "Use the selected language for every visible label, control, empty state, table heading, accessibility description, and the document `lang` value. Use a subject-specific title and omit generic format labels such as `Interactive evidence dashboard`, `dashboard`, or `report` unless the user explicitly requests one.",
          "For a color-rich presentation, use the template's named palette and distinct `accent-*` classes across linked views. For a restrained presentation, omit decorative `accent-*` variety and keep one primary data accent plus neutral structure. In both versions, use visible marks, heatmap fallbacks, labels, and legends so color is never the only signal.",
          "Make the documented initial state answer the broad question before interaction. Include a concise summary, visible matching and total counts, two to four complementary linked views, a semantic detail table, definitions, reduction disclosures, lineage, and a useful static `noscript` summary.",
          "Serialize exactly one manifest and one presentation-data JSON block, escaping every less-than character as `\\u003c`. Render every data-derived label, cell, summary, and tooltip alternative with DOM methods and `textContent`, never data-concatenated markup.",
        ],
      },
      {
        id: "linked-interaction",
        title: "Drive every linked view from one filtered result",
        instructions: [
          "Keep one `state` object in memory. On each filter, search, range, sort, selection, or reset change, derive one filtered row array and pass it to counts, every linked view, the detail table, and the empty state so they cannot disagree.",
          'Use visibly labeled native controls and buttons, preserve keyboard operation and visible focus, provide one-click reset to the documented initial state, keep the matching count in an `aria-live="polite"` region, and retain reset plus a meaningful message when no rows match.',
          "Expose the centralized sort field and direction on every sortable table header with `aria-sort`, and keep each sort button's accessible name synchronized with its current and next action. Run the same sort-state renderer on initial display, every sort update, and reset so stale direction labels cannot survive.",
        ],
      },
      {
        id: "verification",
        title: "Verify and hand off",
        instructions: [
          "Keep the result one self-contained offline HTML file. Use no CDN, remote script, stylesheet, font, image, tile, API, telemetry, network constructor, dynamic import, browser storage, arbitrary expression, inline event handler, `eval`, or `new Function`.",
          "Run `node ../klopsi-shared/scripts/verify-dashboard.mjs <dashboard.html> --mode interactive --json`, repair every finding, then review the useful initial state, linked counts and views, computed styles or a screenshot for nonzero chart marks and distinct heatmap fills, legends, keyboard order, reset, sorting, empty state, one filtered state, responsive layout, and offline opening before handoff.",
          "Hand off the absolute HTML path, verifier JSON, exact embedded row and byte counts, reduction disclosure when applicable, and source-verification status. A verifier pass is presentation evidence, not official artifact provenance.",
        ],
      },
    ],
    safety: [
      "Do not claim provenance from a presentation-verifier pass; use `provenance verify` for provenance claims.",
      "Do not fabricate geography, units, precision, causal claims, verification, lineage, or reduction details.",
    ],
    related: ["klopsi-analysis", "klopsi-services", "klopsi-provenance"],
  },
  {
    kind: "command",
    name: "klopsi-local-state",
    description: "Use when inspecting or changing the KLOPSI cache or non-secret configuration.",
    commands: [
      "cache info",
      "cache list",
      "cache clear",
      "cache prune",
      "cache verify",
      "config get",
      "config set",
      "config list",
      "config path",
    ],
    purpose: "Manage local cache and validated non-secret CLI configuration.",
    workflows: [
      "Inspect cache state before pruning or clearing it.",
      "Locate and inspect configuration before changing a value.",
    ],
    capabilities: [
      {
        id: "cache-tiers",
        title: "Distinguish cache tiers from downloads",
        instructions: [
          "The cache holds the catalogue snapshot and cached raw objects alongside rebuildable derived DuckDB stages; `cache list` labels entries as `raw` or `duckdb-stage`.",
          "Files written by `download` are destination files, not cache entries; preserve them separately when they matter, while a derived DuckDB stage can be rebuilt from its input.",
        ],
      },
      {
        id: "cache-mutations",
        title: "Inspect before mutating cache state",
        instructions: [
          "Use `cache info`, `cache list`, and `cache verify` before `cache prune` or `cache clear` to understand size, entry kind, and integrity.",
          "`cache prune` removes unreferenced raw objects and expired or over-budget derived stages; `cache clear` removes the whole cache. Require explicit authorization before either mutation, then use `--yes` only for that authorized operation.",
        ],
      },
      {
        id: "configuration",
        title: "Inspect validated non-secret configuration",
        instructions: [
          "Use `config path`, `config list`, and `config get <key>` to locate and inspect a value before `config set <key> <value>`; configuration values are validated when written.",
          "Keep secrets out of configuration: secret-like keys cannot be persisted, so provide credentials through environment variables for the current process instead.",
        ],
      },
    ],
    safety: ["Confirm cache clear or prune unless the exact mutation is already authorized."],
    related: ["klopsi-diagnostics"],
  },
  {
    kind: "command",
    name: "klopsi-diagnostics",
    description:
      "Use when diagnosing KLOPSI, generating shell completion or Agent Skills, or performing agent setup.",
    commands: ["providers list", "doctor", "completion", "generate-skills", "agent setup"],
    purpose:
      "Generate installable Agent Skills, diagnose the CLI environment, and expose providers and shell integration.",
    workflows: [
      "Use `klopsi agent setup` to detect installed agent hosts and install the complete KLOPSI skill repertoire globally.",
      "Setup copies generated skills before removing its temporary source, so completed installations remain durable.",
      "Use `--dry-run` to inspect the installation plan, or `--agent` when the target host IDs are already known.",
      "Run offline diagnostics first when network access is unavailable or unwanted.",
    ],
    capabilities: [
      {
        id: "environment-diagnostics",
        title: "Diagnose the environment without network access",
        instructions: [
          "Run `klopsi doctor --offline --json` first when network access is unavailable or unwanted; offline mode skips the connectivity check while retaining local environment, cache, DuckDB, and format checks.",
          "Run `klopsi providers list --offline --json` to record the registered provider inventory without turning diagnosis into a network request.",
          "Read every failed or skipped check in structured output before changing the environment, configuration, or cache.",
        ],
      },
      {
        id: "shell-integration",
        title: "Generate shell completion",
        instructions: [
          "Use `klopsi completion <bash|zsh|fish>` to print completion for the selected shell, then follow that shell's normal installation or sourcing workflow.",
          "Regenerate completion after upgrading KLOPSI rather than editing generated completion output.",
        ],
      },
      {
        id: "skill-generation",
        title: "Generate a portable skill tree",
        instructions: [
          "`generate-skills` writes the complete portable repertoire to its output directory but does not install it into an agent host.",
          "Use `klopsi generate-skills --output-dir ./generated-skills --json` when another workflow needs a portable tree instead of a host installation.",
        ],
      },
      {
        id: "agent-refresh",
        title: "Preview, install, and refresh agent skills",
        instructions: [
          "Detected hosts are used only for a non-dry-run setup without `--agent` or `--all`; `--agent` selects explicit hosts, `--all` selects every supported host, and `--yes` accepts detected hosts for unattended setup.",
          "`--dry-run` reports the planned selection and repertoire without installing or detecting hosts. An empty detection result fails safely and never expands `--yes` to every supported host.",
          "Use this refresh recipe: `klopsi doctor --offline --json`; `klopsi agent setup --agent codex --dry-run --json`; `klopsi agent setup --agent codex --yes --json`.",
          "`agent setup` installs or refreshes the complete repertoire for selected hosts as durable copies. Rerun `klopsi agent setup` to refresh a stale repertoire, then verify in structured setup output that `agents` contains the requested host and `skills` contains the complete repertoire. Do not infer an installed host path or use a guessed filesystem location. `generate-skills` does not install or refresh Codex; use it only for a portable tree.",
        ],
      },
    ],
    safety: [
      "Do not turn a diagnostic check into a network request when offline was requested.",
      "In non-interactive use, require `--yes`, `--agent`, or `--all` before installing skills.",
    ],
    related: ["klopsi-local-state"],
  },
] as const;

export function validateAgentSkills(
  skills: readonly AgentSkillDefinition[] = AGENT_SKILLS,
  commands: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): readonly string[] {
  const problems: string[] = [];
  const skillNames = skills.map((entry) => entry.name);
  const commandPaths = new Set(commands.map((entry) => entry.path));

  for (const required of ["klopsi", "klopsi-shared"] as const) {
    if (!skillNames.includes(required)) problems.push(`Missing required skill "${required}".`);
  }

  const seenNames = new Set<string>();
  for (const entry of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name)) {
      problems.push(`Invalid skill name "${entry.name}".`);
    }
    if (seenNames.has(entry.name)) problems.push(`Duplicate skill name "${entry.name}".`);
    seenNames.add(entry.name);
    if (entry.kind === "command" && entry.commands.length === 0) {
      problems.push(`Command skill "${entry.name}" must own at least one command.`);
    }
    if (entry.kind !== "command" && entry.commands.length > 0) {
      const kind = `${entry.kind[0]?.toUpperCase()}${entry.kind.slice(1)}`;
      problems.push(`${kind} skill "${entry.name}" must not own commands.`);
    }
    const seenCapabilityIds = new Set<string>();
    for (const capability of entry.capabilities) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(capability.id)) {
        problems.push(`Invalid capability ID "${capability.id}" in "${entry.name}".`);
      }
      if (seenCapabilityIds.has(capability.id)) {
        problems.push(
          `Capability ID "${capability.id}" is listed more than once by "${entry.name}".`,
        );
      }
      seenCapabilityIds.add(capability.id);
      if (capability.title.trim().length === 0) {
        problems.push(
          `Capability "${capability.id}" in "${entry.name}" must have a non-blank title.`,
        );
      }
      if (
        capability.instructions.length === 0 ||
        capability.instructions.some((instruction) => instruction.trim().length === 0)
      ) {
        problems.push(
          `Capability "${capability.id}" in "${entry.name}" must have non-blank instructions.`,
        );
      }
    }
    const seenCommandPaths = new Set<string>();
    for (const path of entry.commands) {
      if (seenCommandPaths.has(path)) {
        problems.push(`Command path "${path}" is listed more than once by "${entry.name}".`);
      }
      seenCommandPaths.add(path);
      if (!commandPaths.has(path)) {
        problems.push(`Unknown command path "${path}" owned by "${entry.name}".`);
      }
    }
    for (const related of entry.related) {
      if (!skillNames.includes(related)) {
        problems.push(`Unknown related skill "${related}" referenced by "${entry.name}".`);
      }
    }
  }

  for (const path of commandPaths) {
    const owners = skills
      .filter((entry) => entry.commands.includes(path))
      .map((entry) => entry.name);
    if (owners.length === 0) {
      problems.push(`Command path "${path}" is not owned by a domain skill.`);
    } else if (owners.length > 1) {
      problems.push(`Command path "${path}" is owned by multiple skills: ${owners.join(", ")}.`);
    }
  }

  return problems;
}

function frontmatter(definition: AgentSkillDefinition): string {
  return `---
name: ${definition.name}
description: ${JSON.stringify(definition.description)}
---
`;
}

function tableText(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function optionValue(option: CommandOptionManifest): string {
  if (option.choices !== undefined) {
    return option.choices.map((choice) => `\`${choice}\``).join(", ");
  }
  return option.flags.match(/[<[]([^>\]]+)[>\]]/u)?.[1] ?? "—";
}

function optionLabel(option: CommandOptionManifest): string {
  return `\`${tableText(option.flags)}\``;
}

function longOptionFlag(option: CommandOptionManifest): string | undefined {
  return option.flags.match(/--[a-z][a-z0-9-]*/u)?.[0];
}

function optionAttributeName(option: CommandOptionManifest): string | undefined {
  return longOptionFlag(option)
    ?.slice(2)
    .replace(/^no-/u, "")
    .replace(/-([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());
}

function optionConflicts(
  option: CommandOptionManifest,
  availableOptions: readonly CommandOptionManifest[],
): string {
  return option.conflicts === undefined
    ? "—"
    : option.conflicts
        .map((item) => {
          const conflictingOption = availableOptions.find(
            (candidate) => optionAttributeName(candidate) === item,
          );
          const conflictLabel =
            conflictingOption === undefined ? item : (longOptionFlag(conflictingOption) ?? item);
          return `\`${conflictLabel}\``;
        })
        .join(", ");
}

function commandUsage(entry: CommandManifestEntry): string {
  const commandArguments = entry.arguments.map((argument) => argument.name).join(" ");
  const requiredOptions = entry.options
    .filter((option) => option.mandatory === true)
    .map((option) => option.flags)
    .join(" ");
  const optional = entry.options.some((option) => option.mandatory !== true) ? "[options]" : "";
  return ["klopsi", entry.path, commandArguments, requiredOptions, optional]
    .filter((part) => part.length > 0)
    .join(" ");
}

function renderArguments(entry: CommandManifestEntry): string {
  if (entry.arguments.length === 0) return "";
  const rows = entry.arguments
    .map((argument) => {
      const choices =
        argument.choices === undefined
          ? "—"
          : argument.choices.map((choice) => `\`${choice}\``).join(", ");
      return `| \`${tableText(argument.name)}\` | ${choices} | ${tableText(argument.description)} |`;
    })
    .join("\n");
  return `#### Arguments

| Argument | Values | Description |
| --- | --- | --- |
${rows}

`;
}

function renderOptions(entry: CommandManifestEntry): string {
  if (entry.options.length === 0) return "";
  const rows = entry.options
    .map(
      (option) =>
        `| ${optionLabel(option)} | ${option.mandatory === true ? "yes" : "no"} | ${optionValue(option)} | ${optionConflicts(option, entry.options)} | ${tableText(option.description)} |`,
    )
    .join("\n");
  return `#### Options

| Option | Required | Values | Conflicts | Description |
| --- | --- | --- | --- | --- |
${rows}

`;
}

function renderCommand(entry: CommandManifestEntry): string {
  return `### \`${entry.path}\`

${entry.description}.

\`\`\`sh
${commandUsage(entry)}
\`\`\`

${renderArguments(entry)}${renderOptions(entry)}`;
}

function renderOrchestrator(definition: AgentSkillDefinition, version: string): string {
  const routes = definition.related
    .map((name) => {
      const target = AGENT_SKILLS.find((candidate) => candidate.name === name);
      if (target === undefined) throw new Error(`Missing related skill: ${name}`);
      return `| ${tableText(target.purpose)} | [${name}](../${name}/SKILL.md) |`;
    })
    .join("\n");
  return `${frontmatter(definition)}
# KLOPSI orchestrator

Use this skill as the main entry point for Slovenian public-data work with the \`klopsi\` CLI. Generated for \`klopsi\` ${version}.

## Route requests

1. Read [klopsi-shared](../klopsi-shared/SKILL.md).
2. Classify the request and load the smallest relevant skill from this table.
3. Load more than one domain skill only when the workflow crosses domains.
4. Execute the documented \`klopsi\` commands and summarize structured results.

| Intent | Skill |
| --- | --- |
${routes}

Do not pass \`/klopsi\`, \`@klopsi\`, or \`$klopsi\` to the shell. Those are host-specific ways to invoke this skill; shell commands begin with \`klopsi\`.

## End-to-end workflows

### ${definition.workflows[0]}

1. Search with a bounded result set, inspect the selected dataset and resource, then preview and validate the chosen input.
2. Download it to a new destination when local processing is needed; then use \`--offline\` for the local validation, query, conversion, and provenance steps.
3. Run \`klopsi profile\` to learn column types, null rates, and value ranges before writing SQL.
4. Keep queries read-only and bounded, authorize any overwrite, and run \`provenance verify\` for important outputs.

### ${definition.workflows[1]}

1. Inspect the canonical WFS resource, list its layers, and inspect the selected layer schema.
2. Preview or count a finite selection before exporting a bounded CSV; preserve the CLI's network safeguards and never send WFS transactions.
3. Verify the exported artifact with provenance.

### ${definition.workflows[2]}

1. Inspect or validate the selected acquired or computed artifact and verify available provenance.
2. Use \`klopsi-dataset-workbench\` to represent the prepared dataset as the \`data\` relation in a writable local workbench with the staged source attached read-only.
3. Offer a dataset-specific \`Example queries\` notebook through supported UI control, and report accurately whether it was created.
4. Install the optional external DuckDB CLI only after explicit authorization; DuckDB UI is not the bounded \`klopsi query\` sandbox.
5. Persist reproducible results with a bounded query export, or continue to a durable HTML presentation workflow.

### ${definition.workflows[3]}

1. Prepare a bounded local artifact with analysis or WFS export, then verify available provenance.
2. Choose \`klopsi-static-dashboard\` for a concise printable board or \`klopsi-interactive-dashboard\` for bounded exploration across linked views.
3. Confirm the presentation language, color treatment, and one to three data-specific questions before creating HTML.
4. Generate one self-contained offline HTML file, disclose reductions and verification status, and run the shared dashboard verifier before handoff.

### ${definition.workflows[4]}

1. Run \`klopsi agent setup --dry-run\` to inspect the planned selection and repertoire.
2. With explicit authorization, select the intended host with \`--agent <id>\` and use \`--yes\` for non-interactive installation.
3. Confirm the result includes the complete reported repertoire; use \`generate-skills\` only when a portable skill tree is needed rather than an installation.

## Routing rules

- Prefer the narrowest skill that fully handles the request.
- Inspect \`klopsi <command> --help\` if runtime syntax might differ from the generated reference.
- Keep identifiers returned by the CLI exact; do not invent dataset or resource IDs.
- Return a concise result grounded in stdout, stderr, and the process exit status.
`;
}

function globalOptionsTable(): string {
  const rows = GLOBAL_OPTION_MANIFEST.map(
    (option) =>
      `| ${optionLabel(option)} | ${optionValue(option)} | ${optionConflicts(option, GLOBAL_OPTION_MANIFEST)} | ${tableText(option.description)} |`,
  ).join("\n");
  return `| Option | Values | Conflicts | Description |
| --- | --- | --- | --- |
${rows}`;
}

function renderShared(definition: AgentSkillDefinition, version: string): string {
  return `${frontmatter(definition)}
# KLOPSI shared execution contract

Read this before using any KLOPSI domain skill. Generated for \`klopsi\` ${version}.

## Install and discover

\`\`\`sh
npm install --global klopsi
klopsi --version
klopsi --help
klopsi <command> --help
\`\`\`

Use the installed CLI as the source of truth when its help differs from generated skill text.

## Structured output

- Prefer \`--json\` for one bounded result envelope or \`--ndjson\` for streamed records.
- Use \`--fields\` and command-specific row limits to keep agent context small.
- Read result data from stdout, diagnostics from stderr, and the exit status as the authoritative success signal.
- Inspect the structured \`error.code\` together with the exit status before choosing remediation.
- Never parse a human-readable table when structured output is available.

## Default decision sequence

1. Resolve a local path, a local:file reference, or an exact \`opsi:resource:\` reference.
2. Inspect unknown inputs, then preview a bounded sample and validate when the next operation depends on content integrity.
3. Download provider data before local-only work, then use \`--offline\` for the remaining local steps when network access is unavailable or unwanted.
4. Perform the requested bounded operation and verify important artifacts with provenance.

## Input and selector choices

- Use a local path for data already on disk and a canonical \`opsi:resource:\` reference for provider data; do not invent IDs or references.
- Use one \`--entry\` or \`--record-path\` reported by resource inspect or the relevant operation's structured error/output; resource inspect can surface ZIP entries and XML record paths.
- Without \`--sheet\`, XLSX resource preview, validate, or query emits \`SHEET_REQUIRED\` with \`context.sheets\` and a suggestion; use one listed sheet.

## Formats and outputs

- Supported tabular workflow formats include JSON, NDJSON, CSV, TSV, XLSX, Parquet, ZIP, XML, and dense PC-Axis when their selected content is supported.
- PC-Axis is input-only and becomes deterministic long-form rows. Preserve sibling \`__code\` strings and distinguish a source-symbol null (\`value: null\` plus \`value__symbol\`) from numeric zero.
- Choose \`--json\` for one bounded envelope, \`--ndjson\` for records, and command-specific \`--output\` for a persisted artifact; use spreadsheet-safe output when needed.

## Presentation artifacts

- Read [the dashboard presentation contract](references/presentation-contract.md) before creating a static or interactive HTML presentation.
- Run \`node ../klopsi-shared/scripts/verify-dashboard.mjs <dashboard.html> --mode <static|interactive> --json\` and repair every finding before handoff.
- Passing the dashboard verifier is presentation evidence, not official artifact provenance; use \`klopsi provenance verify\` for provenance claims.

## Global options

${globalOptionsTable()}

## Network and offline behavior

- Pass \`--offline\` when network access is prohibited. Do not imply that an uncached request can succeed offline.
- Preserve HTTPS, DNS, redirect, timeout, download-size, query, memory, thread, cell, and output bounds.
- Use \`--allow-insecure-http\` or \`--allow-private-network\` only after the user explicitly accepts that invocation's risk.
- Do not blindly retry invalid input, unsupported operations, validation failures, or integrity failures.

## Safety

${definition.safety.map((item) => `- ${item}`).join("\n")}

## Confirm mutations

- Confirm before \`cache clear\` or \`cache prune\` unless the user already requested that exact operation.
- Confirm before using \`--force\` to replace an artifact unless that exact overwrite is already authorized.
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
- Use canonical references returned by \`klopsi\` when available.
`;
}

function renderRelated(definition: AgentSkillDefinition): string {
  if (definition.related.length === 0) return "";
  return `## Related skills

${definition.related.map((name) => `- [${name}](../${name}/SKILL.md)`).join("\n")}

`;
}

function renderCapabilities(definition: AgentSkillDefinition): string {
  if (definition.capabilities.length === 0) return "";
  const sections = definition.capabilities
    .map(
      ({ title, instructions }) =>
        `### ${title}\n\n${instructions.map((instruction) => `- ${instruction}`).join("\n")}`,
    )
    .join("\n\n");
  return `## Capability guide\n\n${sections}\n\n`;
}

function renderSafety(definition: AgentSkillDefinition): string {
  if (definition.safety.length === 0) return "";
  return `## Safety\n\n${definition.safety.map((item) => `- ${item}`).join("\n")}\n\n`;
}

function renderDomainSkill(definition: AgentSkillDefinition, version: string): string {
  const entries = definition.commands.map((path) => {
    const entry = COMMAND_MANIFEST.find((candidate) => candidate.path === path);
    if (entry === undefined) throw new Error(`Missing command manifest entry: ${path}`);
    return entry;
  });
  return `${frontmatter(definition)}
# ${definition.name}

> **Prerequisite:** Read [klopsi-shared](../klopsi-shared/SKILL.md) before executing these commands.

${definition.purpose} Generated for \`klopsi\` ${version}.

## Workflow

${definition.workflows.map((workflow) => `- ${workflow}`).join("\n")}

${renderCapabilities(definition)}## Commands

${entries.map(renderCommand).join("\n")}${renderSafety(definition)}${renderRelated(definition)}`;
}

function renderWorkflowSkill(definition: AgentSkillDefinition, version: string): string {
  return `${frontmatter(definition)}
# ${definition.name}

> **Prerequisite:** Read [klopsi-shared](../klopsi-shared/SKILL.md) before creating an artifact.

${definition.purpose} Generated for \`klopsi\` ${version}.

## Workflow

${definition.workflows.map((item) => `- ${item}`).join("\n")}

${renderCapabilities(definition)}${renderSafety(definition)}${renderRelated(definition)}`;
}

function renderSkill(definition: AgentSkillDefinition, version: string): string {
  if (definition.kind === "router") return renderOrchestrator(definition, version);
  if (definition.kind === "shared") return renderShared(definition, version);
  if (definition.kind === "workflow") return renderWorkflowSkill(definition, version);
  return renderDomainSkill(definition, version);
}

function renderAgentSkillFilesInternal(version: string): ReadonlyMap<string, string> {
  const problems = validateAgentSkills();
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return new Map(
    AGENT_SKILLS.map((entry) => [entry.name, `${renderSkill(entry, version).trimEnd()}\n`]),
  );
}

const RESOURCE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/u;

function validateResourcePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment === "." || segment === ".." || !RESOURCE_SEGMENT.test(segment))
  ) {
    throw invalidSkillOutput(path);
  }
}

export function renderAgentSkillPackages(version: string): ReadonlyMap<string, AgentSkillPackage> {
  const skillFiles = renderAgentSkillFilesInternal(version);
  return new Map(
    [...skillFiles].map(([name, skillFile]) => {
      const resources = resourcesForAgentSkill(name);
      for (const resource of resources) validateResourcePath(resource.path);
      return [
        name,
        {
          name,
          files: new Map([
            ["SKILL.md", skillFile],
            ...resources.map(
              (resource) =>
                [
                  resource.path,
                  resource.content.endsWith("\n") ? resource.content : `${resource.content}\n`,
                ] as const,
            ),
          ]),
        },
      ];
    }),
  );
}

export function renderAgentSkillFiles(version: string): ReadonlyMap<string, string> {
  return new Map(
    [...renderAgentSkillPackages(version)].map(([name, skillPackage]) => {
      const skillFile = skillPackage.files.get("SKILL.md");
      if (skillFile === undefined) throw new Error(`Missing SKILL.md for Agent Skill: ${name}`);
      return [name, skillFile];
    }),
  );
}

export function renderAgentSkillsIndex(): string {
  const rows = AGENT_SKILLS.map(
    (entry) => `| [${entry.name}](../skills/${entry.name}/SKILL.md) | ${entry.description} |`,
  ).join("\n");
  return `# KLOPSI Agent Skills

Installable Agent Skills for using the KLOPSI CLI from compatible AI agents. Run \`klopsi agent setup\` for automatic host detection and global installation of the complete repertoire. To manage a project-local installation manually, install the repertoire with a compatible Agent Skills installer, or install one focused domain skill and its \`klopsi-shared\` prerequisite.

| Skill | Description |
| --- | --- |
${rows}
`;
}

export interface GenerateAgentSkillsOptions {
  readonly cwd: string;
  readonly outputDirectory?: string;
  readonly version: string;
}

export interface GenerateAgentSkillsResult {
  readonly outputDirectory: string;
  readonly count: number;
  readonly skills: readonly string[];
}

function invalidSkillOutput(path: string, cause?: unknown): KlopsiError {
  return new KlopsiError({
    code: "SKILL_OUTPUT_INVALID",
    message: `The Agent Skills output must be a writable directory: ${path}`,
    exitCode: EXIT_CODES.INVALID_INPUT,
    suggestion: "Choose a directory path with --output-dir.",
    ...(cause === undefined ? {} : { cause }),
  });
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidSkillOutput(path);
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") throw invalidSkillOutput(path, error);
    throw error;
  }
}

async function ensureNestedDirectory(root: string, relativeDirectory: string): Promise<string> {
  let directory = root;
  for (const segment of relativeDirectory === "" ? [] : relativeDirectory.split("/")) {
    directory = join(directory, segment);
    await ensurePlainDirectory(directory);
  }
  return directory;
}

async function ensureReplaceableFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw invalidSkillOutput(path);
    if (!metadata.isFile()) throw new Error(`Agent Skill file target is not a file: ${path}`);
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeSkillFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await ensureReplaceableFile(path);
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function skillGenerationFailed(outputDirectory: string, cause: unknown): KlopsiError {
  return new KlopsiError({
    code: "SKILL_GENERATION_FAILED",
    message: `Agent Skills could not be written to ${outputDirectory}.`,
    exitCode: EXIT_CODES.INTERNAL,
    suggestion: "Check directory permissions and available disk space, then try again.",
    cause,
  });
}

export async function writeAgentSkillPackages(
  outputDirectory: string,
  packages: ReadonlyMap<string, AgentSkillPackage>,
): Promise<void> {
  try {
    await ensurePlainDirectory(outputDirectory);
    for (const [name, skillPackage] of packages) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || skillPackage.name !== name) {
        throw invalidSkillOutput(name);
      }
      const skillDirectory = join(outputDirectory, name);
      await ensurePlainDirectory(skillDirectory);
      for (const [relativePath, content] of skillPackage.files) {
        if (relativePath !== "SKILL.md") validateResourcePath(relativePath);
        const segments = relativePath.split("/");
        const fileName = segments.pop();
        if (fileName === undefined) throw invalidSkillOutput(relativePath);
        const directory = await ensureNestedDirectory(skillDirectory, segments.join("/"));
        await writeSkillFile(join(directory, fileName), content);
      }
    }
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    throw skillGenerationFailed(outputDirectory, error);
  }
}

export async function generateAgentSkills(
  options: GenerateAgentSkillsOptions,
): Promise<GenerateAgentSkillsResult> {
  const requested = options.outputDirectory ?? "skills";
  const outputDirectory = isAbsolute(requested)
    ? resolve(requested)
    : resolve(options.cwd, requested);
  const packages = renderAgentSkillPackages(options.version);

  await writeAgentSkillPackages(outputDirectory, packages);

  return {
    outputDirectory,
    count: packages.size,
    skills: [...packages.keys()],
  };
}
