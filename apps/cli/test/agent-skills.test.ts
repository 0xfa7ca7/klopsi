import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILLS,
  renderAgentSkillFiles,
  renderAgentSkillPackages,
  renderAgentSkillsIndex,
  type AgentSkillCapabilityGuide,
  type AgentSkillKind,
  type AgentSkillPackage,
  validateAgentSkills,
  type AgentSkillDefinition,
  writeAgentSkillPackages,
} from "../src/agent-skills.js";
import {
  COMMAND_MANIFEST,
  GLOBAL_OPTION_MANIFEST,
  type CommandOptionManifest,
  type CommandManifestEntry,
} from "../src/command-manifest.js";
import { VERSION } from "../src/main.js";

const EXPECTED_SKILLS = [
  "klopsi",
  "klopsi-shared",
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
] as const;

const EXPECTED_DATA_CAPABILITY_IDS = {
  "klopsi-catalogue": ["catalogue-mode", "search-refinement", "dataset-followup"],
  "klopsi-resources": [
    "input-resolution",
    "access-selection",
    "structured-selectors",
    "pcaxis-preview",
  ],
  "klopsi-download": ["target-resolution", "destination-strategy", "partial-results"],
  "klopsi-validation": ["validation-mode", "structured-selectors", "failure-recovery"],
  "klopsi-analysis": [
    "supported-inputs",
    "column-profile",
    "bounded-query",
    "query-export",
    "safe-conversion",
  ],
  "klopsi-provenance": ["record-inspection", "integrity-verification"],
} as const;

const EXPECTED_LOCAL_STATE_CAPABILITY_IDS = {
  "klopsi-local-state": ["cache-tiers", "cache-mutations", "configuration"],
  "klopsi-diagnostics": [
    "environment-diagnostics",
    "shell-integration",
    "skill-generation",
    "agent-refresh",
  ],
} as const;

const EXPECTED_WFS_CAPABILITY_IDS = [
  "wfs-sequence",
  "feature-selection",
  "spatial-filtering",
  "bounded-export",
] as const;

const EXPECTED_STATIC_DASHBOARD_CAPABILITY_IDS = [
  "presentation-preflight",
  "input-readiness",
  "encoding-selection",
  "board-composition",
  "verification",
] as const;

const EXPECTED_INTERACTIVE_DASHBOARD_CAPABILITY_IDS = [
  "presentation-preflight",
  "input-readiness",
  "bounded-embedding",
  "initial-overview",
  "linked-interaction",
  "verification",
] as const;

const EXPECTED_DATASET_WORKBENCH_CAPABILITY_IDS = [
  "representation-fit",
  "open-workbench",
  "example-queries",
  "optional-installation",
  "handoff",
  "preserve-results",
] as const;

const REQUIRED_GUIDANCE = {
  klopsi: [
    "## End-to-end workflows",
    "Acquire and analyze data",
    "Inspect and export WFS data",
    "Refresh an agent installation",
  ],
  "klopsi-shared": [
    "## Default decision sequence",
    "local path",
    "opsi:resource:",
    "--entry",
    "--record-path",
    "--sheet",
    "JSON, NDJSON, CSV, TSV, XLSX, Parquet",
    "offline",
  ],
  "klopsi-catalogue": [
    "snapshot",
    "--refresh",
    "--live",
    "--all",
    "dataset resources",
    "dataset schema",
  ],
  "klopsi-resources": [
    "resource inspect",
    "resource preview",
    "--entry",
    "--record-path",
    "--sheet",
    "WFS",
  ],
  "klopsi-download": [
    "--dataset",
    "--resource",
    "one resource",
    "batch",
    "Partial success",
    "provenance verify",
  ],
  "klopsi-validation": ["--metadata", "--entry", "--record-path", "--sheet", "exit 6"],
  "klopsi-analysis": [
    "CSV",
    "TSV",
    "JSON",
    "NDJSON",
    "XLSX",
    "Parquet",
    "ZIP",
    "XML",
    "SELECT",
    "WITH",
    "VALUES",
    "--output",
    "--spreadsheet-safe",
    "provenance verify",
  ],
  "klopsi-dataset-workbench": [
    "represent",
    "writable",
    "attached read-only",
    "table `data`",
    "Example queries",
    "supported UI",
    "never claim",
    "DuckDB dataset workbench",
    "Open workbench",
    "Dataset",
    "Checks",
    "Sources",
    "session-local",
    "--install",
    "static HTML",
    "interactive HTML",
  ],
  "klopsi-provenance": ["provenance show", "provenance verify", "digest mismatch", "Do not mutate"],
} as const;

const command = (path: string): CommandManifestEntry => ({
  path,
  description: `Run ${path}`,
  arguments: [],
  options: [],
});

const skill = (
  name: string,
  commands: readonly string[] = [],
  kind: AgentSkillKind = name === "klopsi"
    ? "router"
    : name === "klopsi-shared"
      ? "shared"
      : "command",
): AgentSkillDefinition => ({
  kind,
  name,
  description: `${name} description`,
  commands,
  purpose: `${name} purpose`,
  workflows: [],
  capabilities: [],
  safety: [],
  related: [],
});

const skillWithCapabilities = (
  name: string,
  capabilities: readonly AgentSkillCapabilityGuide[],
  commands: readonly string[] = [],
): AgentSkillDefinition => ({ ...skill(name, commands), capabilities });

const minimalSkills = (): readonly AgentSkillDefinition[] => [
  skill("klopsi"),
  skill("klopsi-shared"),
  skill("klopsi-catalogue", ["search"]),
];

const optionAttributeName = (option: CommandOptionManifest): string | undefined =>
  option.flags
    .match(/--[a-z][a-z0-9-]*/u)?.[0]
    ?.slice(2)
    .replace(/^no-/u, "")
    .replace(/-([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());

const conflictFlag = (options: readonly CommandOptionManifest[], conflict: string): string =>
  options
    .find((option) => optionAttributeName(option) === conflict)
    ?.flags.match(/--[a-z][a-z0-9-]*/u)?.[0] ?? conflict;

async function listRelativeFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, relativePath)));
    else files.push(relativePath);
  }
  return files.sort();
}

describe("agent skill registry", () => {
  it("covers the complete approved repertoire and command manifest", () => {
    expect(AGENT_SKILLS.map((entry) => entry.name)).toEqual(EXPECTED_SKILLS);
    expect(validateAgentSkills()).toEqual([]);
  });

  it("registers the static dashboard as a commandless workflow", () => {
    const definition = AGENT_SKILLS.find((entry) => entry.name === "klopsi-static-dashboard");

    expect(definition?.kind).toBe("workflow");
    expect(definition?.commands).toEqual([]);
    expect(definition?.capabilities.map((capability) => capability.id)).toEqual(
      EXPECTED_STATIC_DASHBOARD_CAPABILITY_IDS,
    );
    expect(definition?.related).toEqual([
      "klopsi-analysis",
      "klopsi-services",
      "klopsi-provenance",
    ]);
  });

  it("registers the interactive dashboard as a commandless workflow", () => {
    const definition = AGENT_SKILLS.find((entry) => entry.name === "klopsi-interactive-dashboard");

    expect(definition?.kind).toBe("workflow");
    expect(definition?.commands).toEqual([]);
    expect(definition?.capabilities.map((capability) => capability.id)).toEqual(
      EXPECTED_INTERACTIVE_DASHBOARD_CAPABILITY_IDS,
    );
    expect(definition?.related).toEqual([
      "klopsi-analysis",
      "klopsi-services",
      "klopsi-provenance",
    ]);
  });

  it("registers the dataset workbench as a command skill for database representation", () => {
    const definition = AGENT_SKILLS.find((entry) => entry.name === "klopsi-dataset-workbench");

    expect(definition).toMatchObject({
      kind: "command",
      commands: ["duckdb open", "duckdb install"],
      related: ["klopsi-analysis", "klopsi-static-dashboard", "klopsi-interactive-dashboard"],
    });
    expect(definition?.capabilities.map((capability) => capability.id)).toEqual(
      EXPECTED_DATASET_WORKBENCH_CAPABILITY_IDS,
    );
  });

  it("uses concise discovery triggers for every skill description", () => {
    for (const definition of AGENT_SKILLS) {
      expect(definition.description, definition.name).toMatch(/^Use when /u);
      expect(definition.description.length, definition.name).toBeLessThanOrEqual(500);
    }
  });

  it("assigns the ordered acquisition and analysis capability guides", () => {
    for (const [name, expectedIds] of Object.entries(EXPECTED_DATA_CAPABILITY_IDS)) {
      const definition = AGENT_SKILLS.find((entry) => entry.name === name);
      expect(definition, name).toBeDefined();
      expect(
        definition?.capabilities.map((capability) => capability.id),
        name,
      ).toEqual(expectedIds);
    }
  });

  it("assigns the ordered local-state and diagnostics capability guides", () => {
    for (const [name, expectedIds] of Object.entries(EXPECTED_LOCAL_STATE_CAPABILITY_IDS)) {
      const definition = AGENT_SKILLS.find((entry) => entry.name === name);
      expect(definition, name).toBeDefined();
      expect(
        definition?.capabilities.map((capability) => capability.id),
        name,
      ).toEqual(expectedIds);
    }
  });

  it("reports duplicate and invalid skill names", () => {
    expect(
      validateAgentSkills([...minimalSkills(), skill("klopsi")], [command("search")]),
    ).toContain('Duplicate skill name "klopsi".');
    expect(
      validateAgentSkills(
        [skill("klopsi"), skill("klopsi-shared"), skill("KLOPSI Bad", ["search"])],
        [command("search")],
      ),
    ).toContain('Invalid skill name "KLOPSI Bad".');
  });

  it("reports missing required and commandless domain skills", () => {
    expect(validateAgentSkills([skill("klopsi-catalogue")], [])).toEqual(
      expect.arrayContaining([
        'Missing required skill "klopsi".',
        'Missing required skill "klopsi-shared".',
        'Command skill "klopsi-catalogue" must own at least one command.',
      ]),
    );
  });

  it("reports unknown, missing, and multiply owned command paths", () => {
    expect(
      validateAgentSkills(
        [skill("klopsi"), skill("klopsi-shared"), skill("klopsi-catalogue", ["missing"])],
        [command("search")],
      ),
    ).toEqual(
      expect.arrayContaining([
        'Unknown command path "missing" owned by "klopsi-catalogue".',
        'Command path "search" is not owned by a domain skill.',
      ]),
    );

    expect(
      validateAgentSkills(
        [...minimalSkills(), skill("klopsi-resources", ["search"])],
        [command("search")],
      ),
    ).toContain(
      'Command path "search" is owned by multiple skills: klopsi-catalogue, klopsi-resources.',
    );
  });

  it("reports relationships that cannot be loaded", () => {
    const configured = minimalSkills().map((entry) =>
      entry.name === "klopsi-catalogue" ? { ...entry, related: ["klopsi-missing"] } : entry,
    );

    expect(validateAgentSkills(configured, [command("search")])).toContain(
      'Unknown related skill "klopsi-missing" referenced by "klopsi-catalogue".',
    );
  });

  it("keeps router and shared skills commandless and rejects repeated ownership entries", () => {
    expect(
      validateAgentSkills(
        [skill("klopsi", ["search"]), skill("klopsi-shared")],
        [command("search")],
      ),
    ).toContain('Router skill "klopsi" must not own commands.');
    expect(
      validateAgentSkills(
        [skill("klopsi"), skill("klopsi-shared"), skill("klopsi-catalogue", ["search", "search"])],
        [command("search")],
      ),
    ).toContain('Command path "search" is listed more than once by "klopsi-catalogue".');
  });

  it("accepts commandless workflow skills and enforces kind-specific command ownership", () => {
    expect(
      validateAgentSkills(
        [
          { ...skill("klopsi"), kind: "router" },
          { ...skill("klopsi-shared"), kind: "shared" },
          { ...skill("klopsi-static-dashboard"), kind: "workflow" },
        ],
        [],
      ),
    ).toEqual([]);

    expect(
      validateAgentSkills(
        [
          { ...skill("klopsi"), kind: "router" },
          { ...skill("klopsi-shared"), kind: "shared" },
          { ...skill("klopsi-analysis"), kind: "command", commands: [] },
        ],
        [],
      ),
    ).toContain('Command skill "klopsi-analysis" must own at least one command.');

    expect(
      validateAgentSkills(
        [
          { ...skill("klopsi"), kind: "router" },
          { ...skill("klopsi-shared"), kind: "shared" },
          { ...skill("klopsi-static-dashboard"), kind: "workflow", commands: ["query"] },
        ],
        [command("query")],
      ),
    ).toContain('Workflow skill "klopsi-static-dashboard" must not own commands.');
  });

  it("reports malformed capability guides", () => {
    const invalidCapabilities = [
      { id: "Bad ID", title: "Valid title", instructions: ["Valid instruction"] },
      { id: "blank-title", title: " ", instructions: ["Valid instruction"] },
      { id: "blank-instruction", title: "Valid title", instructions: [" "] },
      { id: "empty-instructions", title: "Valid title", instructions: [] },
    ] as const;

    expect(
      validateAgentSkills(
        [
          skill("klopsi"),
          skill("klopsi-shared"),
          skillWithCapabilities("klopsi-catalogue", invalidCapabilities, ["search"]),
        ],
        [command("search")],
      ),
    ).toEqual(
      expect.arrayContaining([
        'Invalid capability ID "Bad ID" in "klopsi-catalogue".',
        'Capability "blank-title" in "klopsi-catalogue" must have a non-blank title.',
        'Capability "blank-instruction" in "klopsi-catalogue" must have non-blank instructions.',
        'Capability "empty-instructions" in "klopsi-catalogue" must have non-blank instructions.',
      ]),
    );
  });

  it("reports duplicate capability IDs within a skill", () => {
    expect(
      validateAgentSkills(
        [
          skill("klopsi"),
          skill("klopsi-shared"),
          skillWithCapabilities(
            "klopsi-catalogue",
            [
              { id: "search-refinement", title: "Search", instructions: ["Refine"] },
              { id: "search-refinement", title: "Search again", instructions: ["Refine again"] },
            ],
            ["search"],
          ),
        ],
        [command("search")],
      ),
    ).toContain(
      'Capability ID "search-refinement" is listed more than once by "klopsi-catalogue".',
    );
  });
});

describe("agent skill rendering", () => {
  it("renders one deterministic file per skill and an index", () => {
    const first = renderAgentSkillFiles("1.2.3");
    const second = renderAgentSkillFiles("1.2.3");

    expect([...first.keys()]).toEqual(EXPECTED_SKILLS);
    expect([...second]).toEqual([...first]);
    expect(first.get("klopsi")).toContain("name: klopsi");
    expect(renderAgentSkillsIndex()).toContain("# KLOPSI Agent Skills");
  });

  it("renders deterministic packages with a SKILL.md compatibility view", () => {
    const packages = renderAgentSkillPackages("1.2.3");

    expect(packages.get("klopsi")?.files.get("SKILL.md")).toContain("name: klopsi");
    expect([...packages.get("klopsi")!.files.keys()]).toEqual(["SKILL.md"]);
    expect([...packages.get("klopsi-shared")!.files.keys()]).toEqual([
      "SKILL.md",
      "references/presentation-contract.md",
      "scripts/verify-dashboard.mjs",
    ]);
    expect([...packages.get("klopsi-static-dashboard")!.files.keys()]).toEqual([
      "SKILL.md",
      "assets/static-board.html",
      "references/encoding-guide.md",
    ]);
    expect([...packages.get("klopsi-interactive-dashboard")!.files.keys()]).toEqual([
      "SKILL.md",
      "assets/interactive-dashboard.html",
      "references/interaction-guide.md",
    ]);
    expect([...renderAgentSkillFiles("1.2.3")]).toEqual(
      [...packages].map(([name, value]) => [name, value.files.get("SKILL.md")]),
    );
  });

  it("renders portable frontmatter and bounded deterministic files", () => {
    const files = renderAgentSkillFiles("1.2.3");

    for (const [name, content] of files) {
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u)?.[1]?.split("\n");
      expect(frontmatter, name).toEqual([
        `name: ${name}`,
        expect.stringMatching(/^description: "[^"]+"$/u),
      ]);
      expect(content.endsWith("\n"), name).toBe(true);
      expect(content.endsWith("\n\n"), name).toBe(false);
      expect(content.split("\n").length, name).toBeLessThan(500);
      expect(content, name).not.toMatch(/(?:TBD|TODO|API[_ -]?KEY|real token)/iu);
    }
  });

  it("renders a compact main orchestrator with intent routing", () => {
    const content = renderAgentSkillFiles("1.2.3").get("klopsi") ?? "";
    const router = AGENT_SKILLS.find((entry) => entry.name === "klopsi");

    expect(content).toContain("## Route requests");
    expect(content).toContain("smallest relevant skill");
    expect(content).toContain("Do not pass `/klopsi`, `@klopsi`, or `$klopsi` to the shell");
    const routedSkills = AGENT_SKILLS.find((entry) => entry.name === "klopsi")?.related ?? [];
    for (const skillName of routedSkills) {
      expect(content).toContain(`../${skillName}/SKILL.md`);
    }
    expect(content).toContain("Generate installable Agent Skills");
    expect(router?.related).toEqual(
      expect.arrayContaining([
        "klopsi-dataset-workbench",
        "klopsi-static-dashboard",
        "klopsi-interactive-dashboard",
      ]),
    );
    expect(content).toContain("### Represent and explore a dataset in a database workbench");
    expect(content).toContain(
      "Use `klopsi-dataset-workbench` to represent the prepared dataset as the `data` relation in a writable local workbench with the staged source attached read-only.",
    );
    expect(content).toContain("### Analyze and present data");
    expect(content).toContain(
      "1. Prepare a bounded local artifact with analysis or WFS export, then verify available provenance.",
    );
    expect(content).toContain(
      "2. Choose `klopsi-static-dashboard` for a concise printable board or `klopsi-interactive-dashboard` for bounded exploration across linked views.",
    );
    expect(content).toContain(
      "Confirm the presentation language, color treatment, and one to three data-specific questions before creating HTML.",
    );
    expect(content).toContain(
      "4. Generate one self-contained offline HTML file, disclose reductions and verification status, and run the shared dashboard verifier before handoff.",
    );
    expect(content).toContain("Confirm the result includes the complete reported repertoire");
    expect(content).not.toContain("including `klopsi-services`");
    expect(content).not.toContain("### `search`");
  });

  it("renders accurate Example queries notebook and handoff guidance", () => {
    const content = renderAgentSkillFiles("1.2.3").get("klopsi-dataset-workbench") ?? "";

    expect(content).toContain("Example queries");
    expect(content).toContain("supported UI");
    expect(content).toContain("never claim");
    expect(content).toContain("DuckDB dataset workbench");
    expect(content).toContain("Open workbench");
    expect(content).toContain("Dataset");
    expect(content).toContain("Checks");
    expect(content).toContain("Sources");
    expect(content).toContain("session-local");
    expect(content).not.toContain("_duckdb_ui");
  });

  it("renders the static dashboard workflow and complete authoring resources", () => {
    const packages = renderAgentSkillPackages("1.2.3");
    const presentationContract =
      packages.get("klopsi-shared")?.files.get("references/presentation-contract.md") ?? "";
    const skill = packages.get("klopsi-static-dashboard")?.files.get("SKILL.md") ?? "";
    const template =
      packages.get("klopsi-static-dashboard")?.files.get("assets/static-board.html") ?? "";
    const encoding =
      packages.get("klopsi-static-dashboard")?.files.get("references/encoding-guide.md") ?? "";

    for (const token of [
      "self-contained",
      "offline",
      "static-board.html",
      "encoding-guide.md",
      "provenance verify",
      "10,000",
      "5 MB",
      "15 MB",
      "Do not silently truncate",
      "known CRS",
      "verify-dashboard.mjs",
      "Check for `<artifact>.provenance.json`",
      "Confirm presentation preferences",
      "English or Slovenian",
      "color-rich or restrained",
      "one to three additional data-specific questions",
      "Do not create or copy the HTML template until the user answers",
      "Do not choose defaults",
      "`use your judgment`",
      "subject-specific title",
    ]) {
      expect(skill, token).toContain(token);
    }
    expect(skill).not.toContain("## Commands");
    expect(presentationContract).toContain("## 1. User preflight before presentation creation");
    expect(presentationContract).toContain(
      "Do not start HTML composition until the user answers this checkpoint.",
    );

    for (const marker of [
      "{{TITLE}}",
      "{{SUMMARY}}",
      "{{KPI_CARDS}}",
      "{{VIEW_CARDS}}",
      "{{DETAIL_ROWS}}",
      "{{DISCLOSURES}}",
      "{{LINEAGE}}",
      "{{PRESENTATION_MANIFEST_JSON}}",
    ]) {
      expect(template, marker).toContain(marker);
    }
    expect(template).toContain('role="img"');
    expect(template).toContain("<title>");
    expect(template).toContain("<desc ");
    expect(template).toContain("<table");
    expect(template).toContain("break-inside: avoid");
    expect(template).toContain("data-klopsi-summary");
    expect(template).toContain("data-klopsi-disclosures");
    expect(template).toContain("data-klopsi-lineage");
    expect(template).not.toContain("Static evidence board");
    expect(template.match(/<script\b/gu)).toHaveLength(1);
    expect(template).toContain(
      '<script id="klopsi-presentation-manifest" type="application/json">',
    );
    for (const token of [
      "--color-blue:",
      "--color-cyan:",
      "--color-green:",
      "--color-amber:",
      "--color-orange:",
      "--color-magenta:",
      "--color-violet:",
      ".accent-blue",
      ".accent-green",
      ".accent-amber",
      ".legend",
      ".heat-cell",
    ]) {
      expect(template, token).toContain(token);
    }

    for (const token of [
      "Question",
      "Encoding",
      "population",
      "unit",
      "takeaway",
      'role="img"',
      "known CRS",
      "Do not use color as the only",
      "precision",
      "ranked",
      "named palette",
      "labeled legend",
      "screen and print",
    ]) {
      expect(encoding, token).toContain(token);
    }
  });

  it("renders the interactive dashboard workflow and complete authoring resources", () => {
    const packages = renderAgentSkillPackages("1.2.3");
    const skill = packages.get("klopsi-interactive-dashboard")?.files.get("SKILL.md") ?? "";
    const template =
      packages
        .get("klopsi-interactive-dashboard")
        ?.files.get("assets/interactive-dashboard.html") ?? "";
    const interaction =
      packages.get("klopsi-interactive-dashboard")?.files.get("references/interaction-guide.md") ??
      "";

    for (const token of [
      "self-contained",
      "offline",
      "interactive-dashboard.html",
      "interaction-guide.md",
      "initial state",
      "one `state` object",
      "one filtered row array",
      "provenance verify",
      "10,000",
      "5 MB",
      "15 MB",
      "Do not silently truncate",
      "known CRS",
      "verify-dashboard.mjs",
      "Check for `<artifact>.provenance.json`",
      "textContent",
      "Confirm presentation preferences",
      "English or Slovenian",
      "color-rich or restrained",
      "one to three additional data-specific questions",
      "Do not create or copy the HTML template until the user answers",
      "Do not choose defaults",
      "`use your judgment`",
      "subject-specific title",
    ]) {
      expect(skill, token).toContain(token);
    }
    expect(skill).not.toContain("## Commands");

    for (const marker of [
      "{{TITLE}}",
      "{{SUMMARY}}",
      "{{FILTER_CONTROLS}}",
      "{{INITIAL_MATCHING_COUNT}}",
      "{{TOTAL_COUNT}}",
      "{{VIEW_CARDS}}",
      "{{DETAIL_HEADERS}}",
      "{{DISCLOSURES}}",
      "{{LINEAGE}}",
      "{{NOSCRIPT_SUMMARY}}",
      "{{PRESENTATION_MANIFEST_JSON}}",
      "{{PRESENTATION_DATA_JSON}}",
    ]) {
      expect(template, marker).toContain(marker);
    }
    for (const marker of [
      "data-klopsi-summary",
      "data-klopsi-disclosures",
      "data-klopsi-lineage",
      "data-klopsi-filter-region",
      "data-klopsi-record-count",
      "data-klopsi-detail-table",
      "data-klopsi-reset",
      "data-klopsi-empty-state",
    ]) {
      expect(template, marker).toContain(marker);
    }
    expect(template).toContain("<form");
    expect(template).not.toMatch(/<form\b[^>]*\saction\s*=/iu);
    expect(template).toContain('aria-live="polite"');
    expect(template).toContain("<noscript>");
    expect(template).not.toContain("Interactive evidence dashboard");
    expect(template).toContain("const state =");
    expect(template).toContain("const filteredRows =");
    for (const renderer of [
      "renderCounts(filteredRows)",
      "renderViews(filteredRows)",
      "renderTable(filteredRows)",
      "renderEmptyState(filteredRows)",
    ]) {
      expect(template, renderer).toContain(renderer);
    }
    expect(template).toContain(".textContent =");
    expect(template).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\.sendBeacon\s*\(|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/u,
    );
    expect(template).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/u);
    expect(template).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(template.match(/<script\b/gu)).toHaveLength(3);
    expect(template).toContain(
      '<script id="klopsi-presentation-manifest" type="application/json">',
    );
    expect(template).toContain('<script id="klopsi-presentation-data" type="application/json">');
    for (const token of [
      "--color-blue:",
      "--color-cyan:",
      "--color-green:",
      "--color-amber:",
      "--color-orange:",
      "--color-magenta:",
      "--color-violet:",
      ".accent-blue",
      ".accent-green",
      ".accent-amber",
      ".legend",
      ".heat-cell",
      "--control-line: #8a8f98",
      "border: 1px solid var(--control-line)",
      "@media print",
    ]) {
      expect(template, token).toContain(token);
    }
    expect(template).toMatch(
      /\.bar\s*\{[^}]*display:\s*block;[^}]*height:\s*100%;[^}]*background:\s*var\(--color-blue\);/su,
    );
    expect(template).not.toMatch(/\.bar\s*\{[^}]*min-width:/su);
    expect(template).toMatch(/\.heat-cell\s*\{[^}]*background:\s*var\(--color-blue-soft\)/su);

    for (const token of [
      "categorical filters",
      "numeric ranges",
      "date ranges",
      "text search",
      "one filtered row set",
      "Reset",
      "keyboard",
      "focus",
      "empty state",
      "tooltip",
      "linked highlighting",
      "sorting",
      "bounded detail rows",
      "progressive disclosure",
      "comma-separated",
      "computed style",
      "screenshot",
      "labeled legend",
    ]) {
      expect(interaction, token).toContain(token);
    }
  });

  it("exposes centralized sort state and clears it through reset", () => {
    const template =
      renderAgentSkillPackages("1.2.3")
        .get("klopsi-interactive-dashboard")
        ?.files.get("assets/interactive-dashboard.html") ?? "";

    expect(template).toContain("function renderSortState() {");
    expect(template).toContain('header.setAttribute("aria-sort", direction)');
    expect(template).toContain('button.setAttribute("aria-label", label)');
    expect(template).toContain(
      'const direction = field === state.sortField ? state.sortDirection : "none"',
    );
    expect(template).toContain("renderSortState();\n      }");
    expect(template).toMatch(
      /state\.sortField = initialState\.sortField;[\s\S]*state\.sortDirection = initialState\.sortDirection;[\s\S]*update\(\);/u,
    );
  });

  it("renders the shared execution and safety contract", () => {
    const content = renderAgentSkillFiles("1.2.3").get("klopsi-shared") ?? "";

    for (const expected of [
      "npm install --global klopsi",
      "klopsi --help",
      "--json",
      "--ndjson",
      "stdout",
      "stderr",
      "exit status",
      "error.code",
      "--offline",
      "--allow-insecure-http",
      "--allow-private-network",
      "--force",
      "cache clear",
      "cache prune",
      "Invalid input or configuration",
      "Partial success",
    ]) {
      expect(content).toContain(expected);
    }
    for (const option of GLOBAL_OPTION_MANIFEST) {
      expect(content).toContain(option.flags);
      expect(content).toContain(option.description);
      for (const conflict of option.conflicts ?? []) {
        expect(content).toContain(conflictFlag(GLOBAL_OPTION_MANIFEST, conflict));
      }
    }
    expect(content).toContain("Do not fall back to curl or another raw HTTP client");
    expect(content).toContain("## Presentation artifacts");
    expect(content).toContain("references/presentation-contract.md");
    expect(content).toContain("scripts/verify-dashboard.mjs");
    expect(content).toContain("before handoff");
    expect(content).toContain("not official artifact provenance");
  });

  it("renders the required data workflow guidance and capability guides before commands", () => {
    const files = renderAgentSkillFiles("1.2.3");

    for (const [name, requiredTokens] of Object.entries(REQUIRED_GUIDANCE)) {
      const content = files.get(name) ?? "";
      for (const token of requiredTokens) expect(content, `${name}: ${token}`).toContain(token);
    }

    for (const [name] of Object.entries(EXPECTED_DATA_CAPABILITY_IDS)) {
      const definition = AGENT_SKILLS.find((entry) => entry.name === name);
      const content = files.get(name) ?? "";
      const capabilityGuide = content.indexOf("## Capability guide");
      const commands = content.indexOf("## Commands");

      expect(capabilityGuide, name).toBeGreaterThan(-1);
      expect(commands, name).toBeGreaterThan(capabilityGuide);
      for (const capability of definition?.capabilities ?? []) {
        const title = `### ${capability.title}`;
        expect(content.indexOf(title), `${name}: ${title}`).toBeGreaterThan(capabilityGuide);
        expect(content.indexOf(title), `${name}: ${title}`).toBeLessThan(commands);
        for (const instruction of capability.instructions) {
          const bullet = `- ${instruction}`;
          expect(content.indexOf(bullet), `${name}: ${bullet}`).toBeGreaterThan(
            content.indexOf(title),
          );
          expect(content.indexOf(bullet), `${name}: ${bullet}`).toBeLessThan(commands);
        }
      }
    }
  });

  it("teaches the dense PC-Axis input contract in every affected generated skill", () => {
    const files = renderAgentSkillFiles("1.2.3");
    const required: Readonly<Record<string, readonly string[]>> = {
      "klopsi-shared": ["PC-Axis", "input-only", "long-form"],
      "klopsi-resources": ["__code", "zero-padded", "value__symbol"],
      "klopsi-validation": ["PCAXIS_KEYS_UNSUPPORTED", "PCAXIS_ENCODING_UNSUPPORTED"],
      "klopsi-analysis": ["source-symbol null", "CSV, TSV, JSON, NDJSON, XLSX, or Parquet"],
    };

    for (const [name, tokens] of Object.entries(required)) {
      const content = files.get(name) ?? "";
      for (const token of tokens) expect(content, `${name}: ${token}`).toContain(token);
    }
  });

  it("guides batch downloads to an explicit existing destination directory", () => {
    const content = renderAgentSkillFiles("1.2.3").get("klopsi-download") ?? "";
    const download = COMMAND_MANIFEST.find((entry) => entry.path === "download");

    expect(content).toContain(
      "For a batch, `--destination` or `--output` must name an existing directory; a file destination is valid for one resource only.",
    );
    expect(
      download?.options.find((option) => option.flags.includes("--destination"))?.description,
    ).toBe("destination path (a file for one resource, or an existing directory for a batch)");
  });

  it("renders accurate refresh planning and structured-selector guidance", () => {
    const files = renderAgentSkillFiles("1.2.3");
    const orchestrator = files.get("klopsi") ?? "";
    const resources = files.get("klopsi-resources") ?? "";
    const shared = files.get("klopsi-shared") ?? "";
    const validation = files.get("klopsi-validation") ?? "";

    expect(orchestrator).not.toContain("detected targets");
    expect(orchestrator).toContain("planned selection and repertoire");

    expect(resources).toContain("resource inspect can surface ZIP entries and XML record paths");
    for (const content of [resources, shared, validation]) {
      expect(content).toContain("relevant operation's structured error/output");
      expect(content).toContain("SHEET_REQUIRED");
      expect(content).toContain("context.sheets");
      expect(content).toContain("suggestion");
    }
  });

  it("renders bounded WFS service workflows", () => {
    const definition = AGENT_SKILLS.find((entry) => entry.name === "klopsi-services");
    const content = renderAgentSkillFiles("1.2.3").get("klopsi-services") ?? "";

    expect(definition?.capabilities.map((capability) => capability.id)).toEqual(
      EXPECTED_WFS_CAPABILITY_IDS,
    );
    for (const command of [
      "service inspect",
      "service layers",
      "service schema",
      "service preview",
      "service count",
      "service export",
    ])
      expect(content).toContain(`### \`${command}\``);
    for (const guidance of [
      "canonical `opsi:resource:` reference",
      "`service inspect`",
      "`service layers`",
      "`service schema --layer <name>`",
      "`--property` may repeat or take a comma-separated list",
      "`--filter-eq <field=value>`",
      "booleans, numbers, or strings",
      "not schema-aware XSD coercion",
      "`--bbox <minx,miny,maxx,maxy>`",
      "`--crs <name>` must name the coordinate reference system used for the bbox",
      "`--start-index` is zero-based",
      "`--limit`",
      "`service count`",
      "CSV only",
      "`--force` after explicit overwrite authorization",
      "`provenance verify`",
      "Never send transaction requests, raw CQL, arbitrary XML filters, or direct HTTP calls.",
    ]) {
      expect(content).toContain(guidance);
    }
  });

  it("renders option conflicts as user-facing CLI flags", () => {
    const files = renderAgentSkillFiles("1.2.3");
    const shared = files.get("klopsi-shared") ?? "";
    const catalogue = files.get("klopsi-catalogue") ?? "";

    expect(shared).toContain("`--ndjson`, `--csv`, `--tsv`, `--output-format`");
    expect(shared).not.toContain("`outputFormat`");
    expect(catalogue).toContain("`--limit`");
    expect(catalogue).not.toContain("| `limit` |");
  });

  it("routes skill generation through diagnostics metadata before loading the body", () => {
    const content = renderAgentSkillFiles("1.2.3").get("klopsi-diagnostics") ?? "";
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "";

    expect(frontmatter).toContain("agent setup");
    expect(content).toContain("Generate installable Agent Skills");
    expect(content).toContain("### `agent setup`");
    expect(content).toContain("klopsi agent setup [options]");
    for (const option of ["--agent <ids...>", "--all", "--yes", "--dry-run"]) {
      expect(content).toContain(option);
    }
    expect(content).not.toContain("--copy");
    expect(content).toContain(
      "Setup copies generated skills before removing its temporary source, so completed installations remain durable.",
    );
  });

  it("renders cautious local-state maintenance and agent refresh guidance", () => {
    const files = renderAgentSkillFiles("1.2.3");
    const localState = files.get("klopsi-local-state") ?? "";
    const diagnostics = files.get("klopsi-diagnostics") ?? "";

    for (const guidance of [
      "catalogue snapshot and cached raw objects",
      "rebuildable derived DuckDB stages",
      "`cache info`, `cache list`, and `cache verify` before `cache prune` or `cache clear`",
      "explicit authorization",
      "Keep secrets out of configuration",
    ])
      expect(localState).toContain(guidance);

    for (const guidance of [
      "`klopsi doctor --offline --json`",
      "`klopsi providers list --offline --json`",
      "`klopsi agent setup --agent codex --dry-run --json`",
      "`klopsi agent setup --agent codex --yes --json`",
      "`klopsi generate-skills --output-dir ./generated-skills --json`",
      "does not install it",
      "installs or refreshes the complete repertoire",
      "Detected hosts are used only for a non-dry-run setup without `--agent` or `--all`",
      "`--agent` selects explicit hosts",
      "`--all` selects every supported host",
      "`--dry-run` reports the planned selection and repertoire without installing or detecting hosts",
      "`--yes` accepts detected hosts for unattended setup",
      "empty detection result",
      "durable copies",
      "Rerun `klopsi agent setup` to refresh a stale repertoire",
      "`agents` contains the requested host",
      "`skills` contains the complete repertoire",
      "Do not infer an installed host path",
      "`generate-skills` does not install or refresh Codex",
    ])
      expect(diagnostics).toContain(guidance);
  });

  it("keeps the installer's copy mode out of public agent setup metadata", () => {
    const setup = COMMAND_MANIFEST.find((entry) => entry.path === "agent setup");

    expect(setup?.options.map((option) => option.flags)).toEqual([
      "--agent <ids...>",
      "--all",
      "--yes",
      "--dry-run",
    ]);
  });

  it("renders every owned command directly from manifest metadata", () => {
    const files = renderAgentSkillFiles("1.2.3");

    for (const definition of AGENT_SKILLS.slice(2)) {
      const content = files.get(definition.name) ?? "";
      expect(content).toContain("../klopsi-shared/SKILL.md");
      for (const path of definition.commands) {
        const entry = COMMAND_MANIFEST.find((candidate) => candidate.path === path);
        expect(entry, path).toBeDefined();
        if (entry === undefined) continue;
        expect(content).toContain(`### \`${entry.path}\``);
        expect(content).toContain(entry.description);
        expect(content).toContain(`klopsi ${entry.path}`);
        for (const argument of entry.arguments) {
          expect(content).toContain(argument.name);
          expect(content).toContain(argument.description);
          for (const choice of argument.choices ?? []) expect(content).toContain(choice);
        }
        for (const option of entry.options) {
          expect(content).toContain(option.flags);
          expect(content).toContain(option.description);
          for (const choice of option.choices ?? []) expect(content).toContain(choice);
          for (const conflict of option.conflicts ?? []) {
            expect(content).toContain(conflictFlag(entry.options, conflict));
          }
          if (option.mandatory === true) {
            expect(content).toMatch(
              new RegExp(`${option.flags.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*yes`, "u"),
            );
          }
        }
      }
      for (const related of definition.related) {
        expect(content).toContain(`../${related}/SKILL.md`);
      }
    }
  });

  it("renders a complete linked index", () => {
    const content = renderAgentSkillsIndex();

    for (const definition of AGENT_SKILLS) {
      expect(content).toContain(`../skills/${definition.name}/SKILL.md`);
      expect(content).toContain(definition.description);
    }
  });

  it("matches the complete checked-in skill tree and index byte for byte", async () => {
    const expected = renderAgentSkillPackages(VERSION);
    const skillRoot = resolve(process.cwd(), "skills");
    const expectedFiles = [...expected].flatMap(([name, skillPackage]) =>
      [...skillPackage.files.keys()].map((relativePath) => `${name}/${relativePath}`),
    );

    expect(await listRelativeFiles(skillRoot)).toEqual(expectedFiles.sort());
    for (const [name, skillPackage] of expected) {
      for (const [relativePath, content] of skillPackage.files) {
        const packagePath = `${name}/${relativePath}`;
        expect(await readFile(resolve(skillRoot, packagePath), "utf8"), packagePath).toBe(content);
      }
    }
    expect(await readFile(resolve(process.cwd(), "docs/skills.md"), "utf8")).toBe(
      renderAgentSkillsIndex(),
    );
  });
});

const testPackages = (): ReadonlyMap<string, AgentSkillPackage> =>
  new Map([
    [
      "klopsi-shared",
      {
        name: "klopsi-shared",
        files: new Map([
          ["SKILL.md", "---\nname: klopsi-shared\ndescription: test\n---\n"],
          ["references/contract.md", "contract\n"],
        ]),
      },
    ],
  ]);

describe("agent skill package writing", () => {
  it("writes nested package files and preserves unrelated nested files", async () => {
    const root = await mkdtemp(join(tmpdir(), "klopsi-agent-skills-"));
    const output = join(root, "skills");

    try {
      await writeAgentSkillPackages(output, testPackages());
      expect(
        await readFile(join(output, "klopsi-shared", "references", "contract.md"), "utf8"),
      ).toBe("contract\n");

      const unrelated = join(output, "klopsi-shared", "references", "notes.md");
      await writeFile(unrelated, "keep\n", "utf8");
      await writeAgentSkillPackages(output, testPackages());
      expect(await readFile(unrelated, "utf8")).toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const symlinkTest: typeof it = process.platform === "win32" ? it.skip : it;

  symlinkTest("rejects a symbolic-link nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "klopsi-agent-skills-"));
    const output = join(root, "skills");
    const skillDirectory = join(output, "klopsi-shared");
    const outside = join(root, "outside");

    try {
      await mkdir(skillDirectory, { recursive: true });
      await mkdir(outside);
      await symlink(outside, join(skillDirectory, "references"));

      await expect(writeAgentSkillPackages(output, testPackages())).rejects.toMatchObject({
        code: "SKILL_OUTPUT_INVALID",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  symlinkTest("rejects a symbolic-link known file without replacing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "klopsi-agent-skills-"));
    const output = join(root, "skills");
    const skillDirectory = join(output, "klopsi-shared");
    const outside = join(root, "outside.md");

    try {
      await mkdir(join(skillDirectory, "references"), { recursive: true });
      await writeFile(outside, "outside\n", "utf8");
      await symlink(outside, join(skillDirectory, "references", "contract.md"));

      await expect(writeAgentSkillPackages(output, testPackages())).rejects.toMatchObject({
        code: "SKILL_OUTPUT_INVALID",
      });
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports generation failure when a known file target is a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "klopsi-agent-skills-"));
    const output = join(root, "skills");

    try {
      await mkdir(join(output, "klopsi-shared", "SKILL.md"), { recursive: true });

      await expect(writeAgentSkillPackages(output, testPackages())).rejects.toMatchObject({
        code: "SKILL_GENERATION_FAILED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
