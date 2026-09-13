// Live tests against Steel and Claude. Needs STEEL_API_KEY in the environment; PERISCOPE_LIVE=1 is set for you.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

process.env.PERISCOPE_LIVE = "1";

export default mergeConfig(base, defineConfig({ test: { testTimeout: 300_000 } }));
