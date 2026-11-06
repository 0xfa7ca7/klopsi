import type { KlopsiClient } from "@klopsi/core";
import { resourceId } from "@klopsi/domain";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerResourcePreviewCommand } from "./preview.js";
import { manifestCommand } from "../command-manifest.js";

export function registerResourceCommand(
  program: Command,
  context: CliContext,
  client: KlopsiClient,
): void {
  registerResourcePreviewCommand(program, context, client);
  manifestCommand(program, "resource inspect").action(
    async (
      input: string,
      options: { readonly allowInsecureHttp?: boolean; readonly allowPrivateNetwork?: boolean },
    ) => {
      context.renderer?.write(
        await client.access.inspect(input, {
          allowInsecureHttp: options.allowInsecureHttp ?? false,
          allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        }),
      );
    },
  );
  manifestCommand(program, "resource show").action(async (id: string) => {
    context.renderer?.write(await client.resources.get(resourceId(id)));
  });
  manifestCommand(program, "resource headers").action(
    async (id: string, options: { allowInsecureHttp?: boolean; allowPrivateNetwork?: boolean }) => {
      if (client.downloads === undefined) throw new Error("Download service unavailable");
      const { attempts, ...probe } = await client.downloads.headers(resourceId(id), {
        allowInsecureHttp: options.allowInsecureHttp ?? false,
        allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      });
      context.renderer?.write(probe, attempts === undefined ? {} : { attempts });
    },
  );
}
