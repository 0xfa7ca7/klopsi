---
name: klopsi
description: "Use when a Slovenian public-data, OPSI catalogue, or KLOPSI CLI request needs the relevant skill selected."
---

# KLOPSI orchestrator

Use this skill as the main entry point for Slovenian public-data work with the `klopsi` CLI. Generated for `klopsi` 0.0.2.

## Route requests

1. Read [klopsi-shared](../klopsi-shared/SKILL.md).
2. Classify the request and load the smallest relevant skill from this table.
3. Load more than one domain skill only when the workflow crosses domains.
4. Execute the documented `klopsi` commands and summarize structured results.

| Intent | Skill |
| --- | --- |
| Find datasets and inspect their normalized metadata and tabular schemas. | [klopsi-catalogue](../klopsi-catalogue/SKILL.md) |
| Inspect a resource safely without committing to a full data workflow. | [klopsi-resources](../klopsi-resources/SKILL.md) |
| Download selected provider resources through the CLI's bounded secure downloader. | [klopsi-download](../klopsi-download/SKILL.md) |
| Validate data content or normalized metadata and explain actionable issues. | [klopsi-validation](../klopsi-validation/SKILL.md) |
| Profile columns, analyze tabular inputs with bounded read-only SQL, or convert supported formats. | [klopsi-analysis](../klopsi-analysis/SKILL.md) |
| Represent a resolved tabular dataset as the read-only `data` relation in a writable local database workbench. | [klopsi-dataset-workbench](../klopsi-dataset-workbench/SKILL.md) |
| Access WFS feature services through bounded, schema-validated KLOPSI workflows. | [klopsi-services](../klopsi-services/SKILL.md) |
| Inspect recorded lineage and verify an artifact against its digest. | [klopsi-provenance](../klopsi-provenance/SKILL.md) |
| Turn a prepared local artifact into a self-contained semantic HTML and inline-SVG board that remains useful offline and without JavaScript. | [klopsi-static-dashboard](../klopsi-static-dashboard/SKILL.md) |
| Turn a bounded prepared local artifact into one offline exploratory HTML file whose useful initial overview and linked interactions share a single in-memory data flow. | [klopsi-interactive-dashboard](../klopsi-interactive-dashboard/SKILL.md) |
| Manage local cache and validated non-secret CLI configuration. | [klopsi-local-state](../klopsi-local-state/SKILL.md) |
| Generate installable Agent Skills, diagnose the CLI environment, and expose providers and shell integration. | [klopsi-diagnostics](../klopsi-diagnostics/SKILL.md) |

Do not pass `/klopsi`, `@klopsi`, or `$klopsi` to the shell. Those are host-specific ways to invoke this skill; shell commands begin with `klopsi`.

## End-to-end workflows

### Acquire and analyze data

1. Search with a bounded result set, inspect the selected dataset and resource, then preview and validate the chosen input.
2. Download it to a new destination when local processing is needed; then use `--offline` for the local validation, query, conversion, and provenance steps.
3. Run `klopsi profile` to learn column types, null rates, and value ranges before writing SQL.
4. Keep queries read-only and bounded, authorize any overwrite, and run `provenance verify` for important outputs.

### Inspect and export WFS data

1. Inspect the canonical WFS resource, list its layers, and inspect the selected layer schema.
2. Preview or count a finite selection before exporting a bounded CSV; preserve the CLI's network safeguards and never send WFS transactions.
3. Verify the exported artifact with provenance.

### Represent and explore a dataset in a database workbench

1. Inspect or validate the selected acquired or computed artifact and verify available provenance.
2. Use `klopsi-dataset-workbench` to represent the prepared dataset as the `data` relation in a writable local workbench with the staged source attached read-only.
3. Offer a dataset-specific `Example queries` notebook through supported UI control, and report accurately whether it was created.
4. Install the optional external DuckDB CLI only after explicit authorization; DuckDB UI is not the bounded `klopsi query` sandbox.
5. Persist reproducible results with a bounded query export, or continue to a durable HTML presentation workflow.

### Analyze and present data

1. Prepare a bounded local artifact with analysis or WFS export, then verify available provenance.
2. Choose `klopsi-static-dashboard` for a concise printable board or `klopsi-interactive-dashboard` for bounded exploration across linked views.
3. Confirm the presentation language, color treatment, and one to three data-specific questions before creating HTML.
4. Generate one self-contained offline HTML file, disclose reductions and verification status, and run the shared dashboard verifier before handoff.

### Refresh an agent installation

1. Run `klopsi agent setup --dry-run` to inspect the planned selection and repertoire.
2. With explicit authorization, select the intended host with `--agent <id>` and use `--yes` for non-interactive installation.
3. Confirm the result includes the complete reported repertoire; use `generate-skills` only when a portable skill tree is needed rather than an installation.

## Routing rules

- Prefer the narrowest skill that fully handles the request.
- Inspect `klopsi <command> --help` if runtime syntax might differ from the generated reference.
- Keep identifiers returned by the CLI exact; do not invent dataset or resource IDs.
- Return a concise result grounded in stdout, stderr, and the process exit status.
