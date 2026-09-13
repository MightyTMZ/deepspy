import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Model loading (A5) and the 1,000-point index (A3) are slow on a cold cache.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // SQLite files and a single Qdrant collection are shared state: run serially.
    fileParallelism: false,
    pool: "forks",
  },
});
