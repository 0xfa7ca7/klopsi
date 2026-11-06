import { Command } from "commander";
import { KlopsiClient, ProviderRegistry } from "@klopsi/core";
import { OpsiProvider, OpsiTransport, RequestScheduler } from "@klopsi/provider-opsi";
import { LocalProvider } from "@klopsi/provider-local";
import { ContentCache, ProvenanceStore } from "@klopsi/storage";
import type { DerivedArtifactPolicy } from "@klopsi/storage";
import { parseStorageBytes } from "@klopsi/config";
import {
  CatalogueSnapshotClient,
  ContentCacheCatalogueSnapshotStore,
  DEFAULT_CATALOGUE_BASE_URL,
  StrictHttpsReader,
} from "@klopsi/catalogue-snapshot";
import { registerDatasetCommand } from "./commands/dataset.js";
import { registerProvidersCommand } from "./commands/providers.js";
import { registerResourceCommand } from "./commands/resource.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerDownloadCommand } from "./commands/download.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerProvenanceCommand } from "./commands/provenance.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerConvertCommand } from "./commands/convert.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerProfileCommand } from "./commands/profile.js";
import type { CliContext } from "./context.js";
import { addGlobalOptions } from "./options.js";
import { registerCommandManifest } from "./command-manifest.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerGenerateSkillsCommand } from "./commands/generate-skills.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerServiceCommand } from "./commands/service.js";
import type { AgentInstallerRunner } from "./agent-setup.js";
import { SkillsAgentInstallerRunner } from "./agent-installer-runner.js";
import { PinnedAgentHostRegistry, type AgentHostRegistry } from "./agent-hosts.js";
import { renderOnboarding } from "./onboarding.js";
import { createPresentation } from "./presentation.js";
import { homedir } from "node:os";
import { registerDuckDbCommand } from "./commands/duckdb.js";
import { ProcessDuckDbUiRunner, type DuckDbUiRunner } from "./duckdb-ui-runner.js";

function requestInterval(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function duckdbCachePolicy(context: CliContext): DerivedArtifactPolicy {
  const configuration = context.configuration?.duckdb.cache;
  return {
    enabled: configuration?.enabled ?? true,
    maxBytes: parseStorageBytes(configuration?.maxBytes ?? "10GB") ?? 10_000_000_000,
    ttlMs: (configuration?.ttlDays ?? 30) * 24 * 60 * 60 * 1_000,
  };
}

function createClient(
  context: CliContext,
  cache: ContentCache,
  duckdbCache: DerivedArtifactPolicy,
): KlopsiClient {
  const intervalMs = requestInterval(context.io.env?.OPSI_REQUEST_INTERVAL_MS);
  const configuration = context.configuration;
  const provider = new OpsiProvider(
    new OpsiTransport({
      ...(context.io.env?.OPSI_BASE_URL === undefined
        ? {}
        : { baseUrl: context.io.env.OPSI_BASE_URL }),
      ...(context.configuration?.http.timeoutMs === undefined
        ? {}
        : { timeoutMs: context.configuration.http.timeoutMs }),
      scheduler: new RequestScheduler({ ...(intervalMs === undefined ? {} : { intervalMs }) }),
      ...(configuration?.apiKey === undefined ? {} : { apiKey: configuration.apiKey }),
    }),
    { metadataCache: cache, offline: configuration?.offline ?? false },
  );
  const registry = new ProviderRegistry([
    provider,
    new LocalProvider({ ...(context.io.cwd === undefined ? {} : { cwd: context.io.cwd }) }),
  ]);
  return new KlopsiClient({
    registry,
    providerId: context.configuration?.provider ?? provider.descriptor.id,
    cache,
    duckdbCache,
    cwd: context.io.cwd ?? process.cwd(),
    downloads: {
      downloadDir: configuration?.paths.downloadDir ?? context.io.cwd ?? process.cwd(),
      limits: {
        maxBytes: configuration?.http.maxDownloadBytes ?? 2 * 1024 * 1024 * 1024,
        timeoutMs: configuration?.http.timeoutMs ?? 30_000,
      },
      provenance: new ProvenanceStore(),
      cache,
      offline: configuration?.offline ?? false,
    },
    queryWorkerPath: new URL("./query-worker.js", import.meta.url),
    ...(configuration?.archive === undefined ? {} : { archiveLimits: configuration.archive }),
    ...(configuration?.xml === undefined ? {} : { xmlLimits: configuration.xml }),
  });
}

export interface ProgramDependencies {
  readonly catalogue?: Pick<CatalogueSnapshotClient, "list">;
  readonly agentInstallerRunner?: AgentInstallerRunner;
  readonly agentHostRegistry?: AgentHostRegistry;
  readonly duckDbUiRunner?: DuckDbUiRunner;
}

export function createProgram(
  context: CliContext,
  dependencies: ProgramDependencies = {},
): Command {
  const program = new Command();
  program
    .name("klopsi")
    .description("Discover and work with Slovenian public data")
    .version(context.version)
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (chunk) => context.io.stdout.write(chunk),
      writeErr: (chunk) => context.io.stderr.write(chunk),
    })
    .action(() => {
      if (context.configuration?.output !== undefined && context.configuration.output !== "human") {
        program.help({ error: true });
        return;
      }
      context.io.stdout.write(
        renderOnboarding(
          createPresentation({
            color:
              context.io.stdout.isTTY === true &&
              (context.configuration?.terminal.color ?? context.io.env?.NO_COLOR === undefined),
          }),
        ),
      );
    });
  addGlobalOptions(program);
  registerCommandManifest(program);
  const duckdbCache = duckdbCachePolicy(context);
  const cache = new ContentCache(context.configuration?.paths.cacheDir ?? ".klopsi-cache", {
    maxObjectBytes: Math.max(2 * 1024 * 1024 * 1024, duckdbCache.maxBytes),
  });
  const client = createClient(context, cache, duckdbCache);
  const catalogue =
    dependencies.catalogue ??
    new CatalogueSnapshotClient({
      store: new ContentCacheCatalogueSnapshotStore(cache),
      reader: new StrictHttpsReader({
        baseUrl: DEFAULT_CATALOGUE_BASE_URL,
      }),
      offline: context.configuration?.offline ?? false,
    });
  registerSearchCommand(program, context, client);
  registerDatasetCommand(program, context, client, catalogue);
  registerResourceCommand(program, context, client);
  registerProvidersCommand(program, context, client);
  registerDownloadCommand(program, context, client);
  registerCacheCommand(program, context, client);
  registerProvenanceCommand(program, context);
  registerValidateCommand(program, context, client);
  registerConvertCommand(program, context, client);
  registerQueryCommand(program, context, client);
  registerProfileCommand(program, context, client);
  registerDuckDbCommand(
    program,
    context,
    client,
    dependencies.duckDbUiRunner ??
      new ProcessDuckDbUiRunner({
        home: context.io.home ?? homedir(),
        env: context.io.env ?? process.env,
      }),
  );
  registerServiceCommand(program, context, client);
  registerConfigCommand(program, context);
  registerDoctorCommand(program, context, client);
  registerCompletionCommand(program, context);
  registerGenerateSkillsCommand(program, context);
  registerAgentCommand(
    program,
    context,
    dependencies.agentInstallerRunner ?? new SkillsAgentInstallerRunner(),
    dependencies.agentHostRegistry ?? new PinnedAgentHostRegistry(),
  );
  return program;
}
