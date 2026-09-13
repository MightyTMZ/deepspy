#!/usr/bin/env node
/**
 * Apply migrations to a Periscope database.
 *
 *   pnpm --filter @periscope/knowledge migrate [path]
 *
 * Defaults to $PERISCOPE_DB or ./data/periscope.db. Never deletes or recreates
 * an existing database.
 */

import { Storage } from "../storage.js";

function main(): void {
  const target =
    process.argv[2] ?? process.env["PERISCOPE_DB"] ?? "./data/periscope.db";

  const storage = Storage.open({ path: target });
  try {
    const before = storage.schemaVersion();
    const result = storage.migrate();
    const applied = result.applied.length > 0 ? result.applied.join(", ") : "none";
    process.stdout.write(
      `periscope: ${target}\n` +
        `  schema version: ${before} -> ${storage.schemaVersion()}\n` +
        `  migrations applied: ${applied}\n`,
    );
  } finally {
    storage.close();
  }
}

main();
