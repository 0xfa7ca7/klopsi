import {
  EXIT_CODES,
  KlopsiError,
  datasetId,
  parseCanonicalReference,
  resourceId,
  type ResourceId,
} from "@klopsi/domain";
import type { KlopsiClient } from "@klopsi/core";
import { stat } from "node:fs/promises";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { manifestCommand } from "../command-manifest.js";

interface Options {
  readonly destination?: string;
  readonly output?: string;
  readonly force?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly dataset?: boolean;
  readonly resource?: boolean;
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function registerDownloadCommand(
  program: Command,
  context: CliContext,
  client: KlopsiClient,
): void {
  manifestCommand(program, "download").action(async (ids: string[], options: Options) => {
    if (client.downloads === undefined)
      throw new KlopsiError({
        code: "DOWNLOAD_UNAVAILABLE",
        message: "Downloads are unavailable.",
        exitCode: EXIT_CODES.INTERNAL,
      });
    if (options.destination !== undefined && options.output !== undefined)
      throw new KlopsiError({
        code: "INVALID_DOWNLOAD_DESTINATION",
        message: "Use only one of --destination or --output.",
        exitCode: EXIT_CODES.INVALID_INPUT,
      });
    const destination = options.destination ?? options.output;
    const selections: Array<{ id: ResourceId; providerId?: string }> = [];
    for (const id of ids) {
      const reference = id.includes(":") ? parseCanonicalReference(id) : undefined;
      if (reference?.kind === "file")
        throw new KlopsiError({
          code: "RESOURCE_REFERENCE_REQUIRED",
          message: "Download requires a dataset or resource reference.",
          exitCode: EXIT_CODES.INVALID_INPUT,
        });
      if (
        reference !== undefined &&
        ((options.dataset === true && reference.kind !== "dataset") ||
          (options.resource === true && reference.kind !== "resource"))
      )
        throw new KlopsiError({
          code: "DOWNLOAD_SELECTOR_MISMATCH",
          message: "The explicit selector does not match the canonical reference kind.",
          exitCode: EXIT_CODES.INVALID_INPUT,
          context: { reference: id, selector: options.dataset ? "dataset" : "resource" },
        });
      const kind =
        reference?.kind ??
        (options.dataset ? "dataset" : options.resource ? "resource" : undefined);
      if (kind === undefined)
        throw new KlopsiError({
          code: "AMBIGUOUS_DOWNLOAD_REFERENCE",
          message: `Bare identifier '${id}' is ambiguous.`,
          exitCode: EXIT_CODES.INVALID_INPUT,
          suggestion: "Add --dataset or --resource, or use a canonical reference.",
        });
      const providerId = reference === undefined ? undefined : `${reference.providerId}`;
      if (kind === "dataset") {
        const selectedDataset = reference?.kind === "dataset" ? reference.id : datasetId(id);
        const resources =
          providerId === undefined
            ? await client.datasets.resources(selectedDataset)
            : await client.datasets.resources(selectedDataset, providerId);
        selections.push(
          ...resources.map((item) => ({
            id: item.id,
            ...(providerId === undefined ? {} : { providerId }),
          })),
        );
      } else {
        selections.push({
          id: reference?.kind === "resource" ? reference.id : resourceId(id),
          ...(providerId === undefined ? {} : { providerId }),
        });
      }
    }
    if (selections.length === 0)
      throw new KlopsiError({
        code: "NO_DOWNLOAD_RESOURCES",
        message: "The selection contains no resources.",
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    const uniqueSelections = selections.filter(
      (selection, index) =>
        selections.findIndex(
          (candidate) =>
            candidate.id === selection.id && candidate.providerId === selection.providerId,
        ) === index,
    );
    if (
      uniqueSelections.length > 1 &&
      destination !== undefined &&
      !(await isExistingDirectory(destination))
    )
      throw new KlopsiError({
        code: "INVALID_DOWNLOAD_DESTINATION",
        message: "Multiple resources require an existing destination directory.",
        exitCode: EXIT_CODES.INVALID_INPUT,
        suggestion: "Create the directory first or omit --destination/--output.",
      });
    const results: unknown[] = [];
    const attempts: Array<number | null> = [];
    const errors: unknown[] = [];
    for (const selection of uniqueSelections) {
      try {
        // Network attempts are reported as rendering metadata so result records keep their shape.
        const { attempts: used, ...result } = await client.downloads.resource(selection.id, {
          ...(selection.providerId === undefined ? {} : { providerId: selection.providerId }),
          ...(destination === undefined ? {} : { destination }),
          force: options.force ?? false,
          allowInsecureHttp: options.allowInsecureHttp ?? false,
          allowPrivateNetwork: options.allowPrivateNetwork ?? false,
        });
        results.push(result);
        attempts.push(used ?? null);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      if (results.length > 0)
        throw new KlopsiError({
          code: "PARTIAL_DOWNLOAD",
          message: `${results.length} download(s) succeeded and ${errors.length} failed.`,
          exitCode: EXIT_CODES.PARTIAL_SUCCESS,
          context: {
            data: results,
            failures: errors.map((error) =>
              error instanceof Error ? error.message : String(error),
            ),
          },
        });
      throw errors[0];
    }
    if (results.length > 0) {
      const single = uniqueSelections.length === 1;
      const meta = single
        ? attempts[0] === null
          ? {}
          : { attempts: attempts[0] }
        : attempts.every((value) => value === null)
          ? {}
          : { attempts };
      context.renderer?.write(single ? results[0] : results, meta);
    }
  });
}
