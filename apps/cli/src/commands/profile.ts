import type { Command } from "commander";
import type { KlopsiClient } from "@klopsi/core";
import type { CliContext } from "../context.js";
import { manifestCommand } from "../command-manifest.js";

export function registerProfileCommand(
  program: Command,
  context: CliContext,
  client: KlopsiClient,
): void {
  manifestCommand(program, "profile").action(
    async (
      input: string,
      options: {
        readonly timeoutMs?: number;
        readonly sheet?: string;
        readonly entry?: string;
        readonly recordPath?: string;
        readonly allowInsecureHttp?: boolean;
        readonly allowPrivateNetwork?: boolean;
      },
    ) => {
      const global = program.opts() as {
        queryTimeoutMs?: number;
        duckdbMemoryLimit?: string;
        duckdbThreads?: number;
        quiet?: boolean;
      };
      const timeoutMs =
        options.timeoutMs ?? context.configuration?.query.timeoutMs ?? global.queryTimeoutMs;
      const memoryLimit = context.configuration?.duckdb.memoryLimit ?? global.duckdbMemoryLimit;
      const threads = context.configuration?.duckdb.threads ?? global.duckdbThreads;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const result = await client.query.profile(input, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(memoryLimit === undefined ? {} : { memoryLimit }),
          ...(threads === undefined ? {} : { threads }),
          ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
          ...(options.entry === undefined ? {} : { entry: options.entry }),
          ...(options.recordPath === undefined ? {} : { recordPath: options.recordPath }),
          allowInsecureHttp: options.allowInsecureHttp ?? false,
          allowPrivateNetwork: options.allowPrivateNetwork ?? false,
          signal: controller.signal,
        });
        if (global.quiet !== true)
          for (const warning of result.warnings)
            context.io.stderr.write(`warning [${warning.code}]: ${warning.message}\n`);
        context.renderer?.write(result.columns, {
          source: result.source,
          columnCount: result.columnCount,
          rowCount: result.rowCount,
          durationMs: result.durationMs,
          cache: result.cache,
          ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
        });
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    },
  );
}
