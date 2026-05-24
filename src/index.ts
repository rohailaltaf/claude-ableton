#!/usr/bin/env node
/**
 * Entry point for the claude-ableton MCP server.
 *
 * On launch it (1) ensures the bundled AbletonOSC Remote Script is installed
 * and up to date in Live's User Library, then (2) starts the MCP server on
 * stdio. All logging goes to stderr; stdout is reserved for the MCP protocol.
 */

import { ensureRemoteScriptInstalled } from "./installer.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  try {
    ensureRemoteScriptInstalled();
  } catch (err) {
    // Never fatal: the server can still run if Live already has AbletonOSC.
    console.error(
      `[claude-ableton] remote-script install check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  await startServer();
}

main().catch((err) => {
  console.error(`[claude-ableton] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
