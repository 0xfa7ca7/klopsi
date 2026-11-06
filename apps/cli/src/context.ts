import type { KlopsiConfiguration } from "@klopsi/config";
import type { Renderer, WritableOutput } from "@klopsi/output";

export interface CliIo {
  readonly cwd?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: WritableOutput;
  readonly stderr: WritableOutput;
  readonly stdin?: {
    readonly isTTY?: boolean;
    [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
  };
  readonly confirm?: (message: string) => Promise<boolean>;
}

export interface CliContext {
  readonly io: CliIo;
  readonly version: string;
  readonly configuration?: KlopsiConfiguration;
  readonly renderer?: Renderer;
  readonly openUrl?: (url: string) => Promise<void>;
}

export function processIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    confirm: async (message) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^(?:y|yes)$/iu.test((await prompt.question(`${message} [y/N] `)).trim());
      } finally {
        prompt.close();
      }
    },
  };
}
