import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@periscope/contracts": path.resolve(here, "packages/contracts/src/index.ts") } },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.live.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
