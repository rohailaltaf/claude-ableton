/**
 * AbletonOSC Remote Script auto-installer (Option B: bundle a pinned copy).
 *
 * A version-stamped copy of our AbletonOSC fork is vendored into the package at
 * <pkg>/vendor/AbletonOSC by the build step (scripts/vendor-remote-script.mjs).
 * On EVERY launch we compare the bundled VERSION against the copy installed in
 * Live's User Library and (re)install when they differ — guaranteeing the MCP
 * server and the Remote Script never drift apart.
 *
 * Guards:
 *  - If the installed copy is a git working tree (.git present), we leave it
 *    completely untouched — that's a developer's live checkout of the fork.
 *  - If nothing is bundled yet, we no-op with a hint (dev convenience).
 *
 * macOS-first: the Remote Scripts path is the standard arm64/Intel location.
 * All logging goes to stderr; stdout is the MCP protocol channel.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = "VERSION";

/** Bundled Remote Script: <pkg>/vendor/AbletonOSC (sibling of dist/). */
function bundledRemoteScriptDir(): string {
  return path.resolve(HERE, "..", "vendor", "AbletonOSC");
}

/** Live's Remote Scripts folder (macOS). */
function liveRemoteScriptsDir(): string {
  return path.join(os.homedir(), "Music", "Ableton", "User Library", "Remote Scripts");
}

function readVersion(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, VERSION_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

export function ensureRemoteScriptInstalled(): void {
  const bundled = bundledRemoteScriptDir();
  if (!fs.existsSync(bundled)) {
    console.error(
      `[claude-ableton] no bundled Remote Script at ${bundled}; ` +
        "skipping install (run 'npm run vendor' to populate it).",
    );
    return;
  }

  const bundledVersion = readVersion(bundled);
  const targetRoot = liveRemoteScriptsDir();
  const target = path.join(targetRoot, "AbletonOSC");

  if (fs.existsSync(path.join(target, ".git"))) {
    console.error(
      `[claude-ableton] ${target} is a git working tree; leaving it untouched (dev checkout).`,
    );
    return;
  }

  const installedVersion = fs.existsSync(target) ? readVersion(target) : null;
  if (installedVersion !== null && installedVersion === bundledVersion) {
    return; // already up to date
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(bundled, target, { recursive: true });

  const verLabel = bundledVersion ?? "unknown";
  const what = installedVersion === null ? "Installed" : "Updated";
  console.error(
    `[claude-ableton] ${what} AbletonOSC Remote Script (${verLabel}) → ${target}\n` +
      "[claude-ableton] ACTION REQUIRED: restart Ableton Live, then " +
      "Preferences → Link/Tempo/MIDI → Control Surface → select \"AbletonOSC\".",
  );
}
