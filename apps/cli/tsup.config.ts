import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", "query-worker": "src/query-worker-entry.ts", sdk: "src/sdk.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false,
  noExternal: [/^@klopsi\//],
  external: ["undici", "@duckdb/node-api", "csv-parse", "unzipit"],
});
