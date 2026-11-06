import { registerHooks } from "node:module";

// Source modules use NodeNext `.js` specifiers; map relative ones to their `.ts`
// sources so this unbundled worker can load runtime imports under type stripping.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js"))
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      throw error;
    }
  },
});

const { startQueryWorker } = await import("../../src/query-worker.ts");
startQueryWorker();
