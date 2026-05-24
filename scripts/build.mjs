/**
 * Bundle the MCP server into a single self-contained dist/index.js.
 *
 * Claude plugins are installed by copying the repo — no `npm install`, no build
 * step runs at install time. So we bundle ALL runtime deps
 * (@modelcontextprotocol/sdk, zod, tonal) into one file with esbuild, and the
 * plugin runs `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js` directly. Node
 * built-ins stay external. The shebang banner also makes the file usable as the
 * npm `bin` (for the `npx -y github:...` path).
 */
import { chmodSync } from "node:fs";
import { build } from "esbuild";

const outfile = "dist/index.js";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});

chmodSync(outfile, 0o755); // executable for the `npx`/bin path

console.error(`[build] bundled -> ${outfile}`);
