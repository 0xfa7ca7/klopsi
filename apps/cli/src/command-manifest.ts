import { duckDbMemoryLimitBytes } from "@klopsi/domain";
import { Argument, Command, InvalidArgumentError, Option } from "commander";

type ParserKind = "positive" | "nonnegative" | "collect" | "duckdb-memory";

export interface CommandOptionManifest {
  readonly flags: string;
  readonly description: string;
  readonly choices?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly mandatory?: boolean;
  readonly parser?: ParserKind;
  readonly defaultValue?: unknown;
}

export interface CommandArgumentManifest {
  readonly name: string;
  readonly description: string;
  readonly choices?: readonly string[];
}

export interface CommandManifestEntry {
  readonly path: string;
  readonly description: string;
  readonly arguments: readonly CommandArgumentManifest[];
  readonly options: readonly CommandOptionManifest[];
}

const option = (
  flags: string,
  description: string,
  properties: Omit<CommandOptionManifest, "flags" | "description"> = {},
): CommandOptionManifest => ({ flags, description, ...properties });
const argument = (name: string, description: string, choices?: readonly string[]) => ({
  name,
  description,
  ...(choices === undefined ? {} : { choices }),
});
const leaf = (
  path: string,
  description: string,
  commandArguments: readonly CommandArgumentManifest[] = [],
  options: readonly CommandOptionManifest[] = [],
): CommandManifestEntry => ({ path, description, arguments: commandArguments, options });

const NETWORK_OPTIONS = [
  option("--allow-insecure-http", "allow HTTP for this invocation"),
  option("--allow-private-network", "allow private network addresses for this invocation"),
] as const;

export const GLOBAL_OPTION_MANIFEST: readonly CommandOptionManifest[] = [
  option("--json", "render JSON", { conflicts: ["ndjson", "csv", "tsv", "outputFormat"] }),
  option("--ndjson", "render newline-delimited JSON", {
    conflicts: ["json", "csv", "tsv", "outputFormat"],
  }),
  option("--csv", "render CSV", { conflicts: ["json", "ndjson", "tsv", "outputFormat"] }),
  option("--tsv", "render TSV", { conflicts: ["json", "ndjson", "csv", "outputFormat"] }),
  option("--output-format <format>", "select output format", {
    choices: ["table", "json", "ndjson", "csv", "tsv"],
  }),
  option("--fields <field>", "select output field (repeatable or comma-separated)", {
    parser: "collect",
    defaultValue: [],
  }),
  option("--provider <id>", "select provider", { choices: ["opsi", "local"] }),
  option("--offline", "disable network access"),
  option("--cache-dir <path>", "override cache directory"),
  option("--download-dir <path>", "override download directory"),
  option("--http-timeout-ms <number>", "HTTP timeout in milliseconds", { parser: "positive" }),
  option("--max-download-bytes <number>", "maximum download size", { parser: "positive" }),
  option("--preview-row-limit <number>", "preview row limit", { parser: "positive" }),
  option("--query-row-limit <number>", "query row limit", { parser: "positive" }),
  option("--query-timeout-ms <number>", "query timeout in milliseconds", {
    parser: "positive",
  }),
  option("--duckdb-memory-limit <limit>", "DuckDB memory limit", { parser: "duckdb-memory" }),
  option("--duckdb-threads <number>", "DuckDB worker threads", { parser: "positive" }),
  option("--quiet", "suppress non-result output"),
  option("--debug", "include diagnostic stack traces"),
  option("--no-color", "disable color output"),
] as const;

export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = [
  leaf(
    "search",
    "Search datasets",
    [argument("[text]", "full-text search query")],
    [
      option("--organization <name>", "filter by organization"),
      option("--tag <name>", "filter by tag (repeatable)", { parser: "collect", defaultValue: [] }),
      option("--format <name>", "filter by resource format (repeatable)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--license <id>", "filter by license"),
      option("--modified-after <date>", "filter by earliest modification date"),
      option("--modified-before <date>", "filter by latest modification date"),
      option("--sort <field:direction>", "sort result (repeatable)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--limit <number>", "maximum results", { parser: "positive" }),
      option("--offset <number>", "result offset", { parser: "nonnegative" }),
      option("--all", "retrieve every result page", { conflicts: ["limit"] }),
    ],
  ),
  leaf(
    "dataset list",
    "List all datasets",
    [],
    [
      option("--refresh", "refresh the published catalogue snapshot", { conflicts: ["live"] }),
      option("--live", "query OPSI directly using paginated requests", {
        conflicts: ["refresh"],
      }),
    ],
  ),
  leaf("dataset show", "Show dataset details", [argument("<id>", "dataset identifier")]),
  leaf("dataset resources", "List resources embedded in a dataset", [
    argument("<id>", "dataset identifier"),
  ]),
  leaf(
    "dataset schema",
    "Infer the schema of a dataset's tabular resource",
    [argument("<id>", "dataset identifier")],
    [
      option("--resource <id>", "resource identifier or canonical resource reference"),
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf("dataset open", "Open the provider's public dataset page", [
    argument("<id>", "dataset identifier"),
  ]),
  leaf(
    "resource preview",
    "Preview bounded rows from a local or provider resource",
    [argument("<input>", "local path, local:file reference, resource ID, or canonical resource")],
    [
      option("--limit <rows>", "maximum preview rows", { parser: "positive" }),
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf("resource show", "Show resource details", [argument("<id>", "resource identifier")]),
  leaf(
    "resource inspect",
    "Inspect supported access operations for a resource",
    [argument("<input>", "local path or canonical resource reference")],
    NETWORK_OPTIONS,
  ),
  leaf(
    "resource headers",
    "Probe resource headers securely",
    [argument("<id>", "resource identifier")],
    NETWORK_OPTIONS,
  ),
  leaf("providers list", "List registered providers"),
  leaf(
    "download",
    "Download one or more resources securely",
    [argument("<ids...>", "resource identifiers")],
    [
      option("--dataset", "treat bare identifiers as datasets", { conflicts: ["resource"] }),
      option("--resource", "treat bare identifiers as resources", { conflicts: ["dataset"] }),
      option(
        "--destination <path>",
        "destination path (a file for one resource, or an existing directory for a batch)",
      ),
      option("--output <path>", "alias for --destination"),
      option("--force", "replace the requested regular file"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf("cache info", "Show cache statistics"),
  leaf("cache list", "List cache entries"),
  leaf(
    "cache clear",
    "Clear cache entries",
    [],
    [option("--yes", "confirm deletion without prompting")],
  ),
  leaf(
    "cache prune",
    "Prune unreferenced cache entries",
    [],
    [option("--yes", "confirm deletion without prompting")],
  ),
  leaf("cache verify", "Verify cached content"),
  leaf("provenance show", "Show artifact provenance", [argument("<path>", "artifact path")]),
  leaf("provenance verify", "Verify artifact provenance", [argument("<path>", "artifact path")]),
  leaf(
    "validate",
    "Validate local data, provider resources, or metadata",
    [argument("<input>", "data input or canonical metadata reference")],
    [
      option("--metadata", "validate metadata without fetching resource content"),
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "convert",
    "Convert tabular data between supported formats",
    [argument("<input>", "local path or canonical resource reference")],
    [
      option("--to <format>", "destination data format", {
        choices: ["csv", "tsv", "json", "ndjson", "xlsx", "parquet"],
        mandatory: true,
      }),
      option("--output <path>", "destination file path", { mandatory: true }),
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      option("--force", "replace an existing regular destination"),
      option("--spreadsheet-safe", "prefix formula-like string values"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "query",
    "Run one sandboxed read-only query over tabular data",
    [argument("<input>", "local path or canonical resource reference")],
    [
      option(
        "--sql <query>",
        "one SELECT, WITH ... SELECT, or VALUES statement (or use --sql-file)",
        { conflicts: ["sqlFile"] },
      ),
      option(
        "--sql-file <path>",
        "read the statement from a UTF-8 file, or stdin with - (or use --sql)",
        { conflicts: ["sql"] },
      ),
      option(
        "--param <name=value>",
        "bind a $name placeholder (repeatable; typed name:type=value with int, double, bool, or date)",
        { parser: "collect", defaultValue: [] },
      ),
      option("--limit <rows>", "maximum returned rows", { parser: "positive" }),
      option("--timeout-ms <milliseconds>", "hard query deadline", { parser: "positive" }),
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      option("--output <path>", "export bounded results (.csv, .tsv, .json, .ndjson)"),
      option("--force", "replace an existing output"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "duckdb open",
    "Open tabular data in DuckDB UI",
    [argument("<input>", "local path or canonical resource reference")],
    [
      option("--sheet <name>", "XLSX sheet name"),
      option("--entry <path>", "ZIP data entry path"),
      option("--record-path <path>", "XML record element path"),
      option("--install", "install the optional DuckDB CLI when unavailable"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "duckdb install",
    "Install the optional DuckDB CLI",
    [],
    [option("--yes", "authorize the official DuckDB installer")],
  ),
  leaf(
    "service inspect",
    "Inspect a read-only WFS service",
    [argument("<resource>", "canonical WFS resource reference")],
    NETWORK_OPTIONS,
  ),
  leaf(
    "service layers",
    "List WFS feature layers",
    [argument("<resource>", "canonical WFS resource reference")],
    NETWORK_OPTIONS,
  ),
  leaf(
    "service schema",
    "Describe a WFS feature layer",
    [argument("<resource>", "canonical WFS resource reference")],
    [option("--layer <name>", "feature layer name", { mandatory: true }), ...NETWORK_OPTIONS],
  ),
  leaf(
    "service preview",
    "Preview bounded WFS features",
    [argument("<resource>", "canonical WFS resource reference")],
    [
      option("--layer <name>", "feature layer name", { mandatory: true }),
      option("--limit <rows>", "maximum preview rows", { parser: "positive" }),
      option("--start-index <number>", "zero-based feature offset", { parser: "nonnegative" }),
      option("--property <name>", "selected field (repeatable or comma-separated)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--filter-eq <field=value>", "typed equality filter (repeatable)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--bbox <minx,miny,maxx,maxy>", "bounded spatial extent"),
      option("--crs <name>", "bbox coordinate reference system"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "service count",
    "Count matching WFS features",
    [argument("<resource>", "canonical WFS resource reference")],
    [
      option("--layer <name>", "feature layer name", { mandatory: true }),
      option("--filter-eq <field=value>", "typed equality filter (repeatable)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--bbox <minx,miny,maxx,maxy>", "bounded spatial extent"),
      option("--crs <name>", "bbox coordinate reference system"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf(
    "service export",
    "Export bounded WFS features to CSV",
    [argument("<resource>", "canonical WFS resource reference")],
    [
      option("--layer <name>", "feature layer name", { mandatory: true }),
      option("--output <path>", "destination CSV path", { mandatory: true }),
      option("--limit <rows>", "maximum exported rows", { parser: "positive" }),
      option("--start-index <number>", "zero-based feature offset", { parser: "nonnegative" }),
      option("--property <name>", "selected field (repeatable or comma-separated)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--filter-eq <field=value>", "typed equality filter (repeatable)", {
        parser: "collect",
        defaultValue: [],
      }),
      option("--bbox <minx,miny,maxx,maxy>", "bounded spatial extent"),
      option("--crs <name>", "bbox coordinate reference system"),
      option("--force", "replace an existing regular file"),
      ...NETWORK_OPTIONS,
    ],
  ),
  leaf("config get", "Get a user configuration value", [argument("<key>", "dotted key")]),
  leaf("config set", "Set a validated user configuration value", [
    argument("<key>", "dotted key"),
    argument("<value>", "JSON value or string"),
  ]),
  leaf("config list", "List user configuration"),
  leaf("config path", "Show configuration paths"),
  leaf(
    "doctor",
    "Run installation and environment diagnostics",
    [],
    [option("--offline", "skip connectivity checks")],
  ),
  leaf("completion", "Generate static shell completion", [
    argument("<shell>", "shell name", ["bash", "zsh", "fish"]),
  ]),
  leaf(
    "generate-skills",
    "Generate installable Agent Skills for the klopsi CLI",
    [],
    [option("--output-dir <path>", "directory that receives generated skills")],
  ),
  leaf(
    "agent setup",
    "Install KLOPSI Agent Skills for detected agent hosts",
    [],
    [
      option("--agent <ids...>", "target explicit agent installer IDs"),
      option("--all", "install for every supported agent", { conflicts: ["agent"] }),
      option("--yes", "accept detected agents without prompting"),
      option("--dry-run", "show the setup plan without making changes"),
    ],
  ),
] as const;

const GROUP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  dataset: "Inspect datasets",
  resource: "Inspect resources",
  providers: "Inspect data providers",
  cache: "Inspect and maintain the local cache",
  provenance: "Inspect and verify artifact provenance",
  service: "Inspect read-only WFS services",
  duckdb: "Open data in DuckDB UI",
  config: "Inspect and update user configuration",
  agent: "Set up AI agent integrations",
};

function parsePositive(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

function parseNonnegative(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function parseDuckDbMemory(value: string): string {
  if (duckDbMemoryLimitBytes(value) === undefined)
    throw new InvalidArgumentError("must be a supported positive byte size no larger than 1GB");
  return value;
}

function commanderOption(specification: CommandOptionManifest): Option {
  let result = new Option(specification.flags, specification.description);
  if (specification.choices !== undefined) result = result.choices([...specification.choices]);
  if (specification.conflicts !== undefined)
    result = result.conflicts([...specification.conflicts]);
  if (specification.mandatory === true) result = result.makeOptionMandatory();
  if (specification.parser === "positive") result = result.argParser(parsePositive);
  if (specification.parser === "nonnegative") result = result.argParser(parseNonnegative);
  if (specification.parser === "collect") result = result.argParser(collect);
  if (specification.parser === "duckdb-memory") result = result.argParser(parseDuckDbMemory);
  if (specification.defaultValue !== undefined) result = result.default(specification.defaultValue);
  return result;
}

function applyLeaf(command: Command, specification: CommandManifestEntry): Command {
  command.description(specification.description);
  for (const item of specification.arguments) {
    let registered = new Argument(item.name, item.description);
    if (item.choices !== undefined) registered = registered.choices([...item.choices]);
    command.addArgument(registered);
  }
  for (const item of specification.options) command.addOption(commanderOption(item));
  return command;
}

export function registerCommandManifest(program: Command): void {
  const groups = new Map<string, Command>();
  for (const specification of COMMAND_MANIFEST) {
    const [parentName, childName] = specification.path.split(" ");
    if (parentName === undefined) continue;
    if (childName === undefined) {
      applyLeaf(program.command(parentName), specification);
      continue;
    }
    let parent = groups.get(parentName);
    if (parent === undefined) {
      parent = program
        .command(parentName)
        .description(GROUP_DESCRIPTIONS[parentName] ?? parentName);
      groups.set(parentName, parent);
    }
    applyLeaf(parent.command(childName), specification);
  }
}

export function registerGlobalOptions(program: Command): void {
  for (const item of GLOBAL_OPTION_MANIFEST) program.addOption(commanderOption(item));
}

export function manifestCommand(program: Command, path: string): Command {
  const [parentName, childName] = path.split(" ");
  const parent = program.commands.find((candidate) => candidate.name() === parentName);
  const result =
    childName === undefined
      ? parent
      : parent?.commands.find((candidate) => candidate.name() === childName);
  if (result === undefined) throw new Error(`Command manifest path is not registered: ${path}`);
  return result;
}
