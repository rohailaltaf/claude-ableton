/**
 * Option-B build step: vendor a PINNED copy of our AbletonOSC fork into
 * <pkg>/vendor/AbletonOSC, reproducibly, from GitHub (never from the local
 * machine). Stamps a VERSION file with the pinned commit so the runtime
 * installer can detect drift and reinstall.
 *
 * Run via `npm run vendor` (also runs automatically on `prepublishOnly`).
 *
 * To bump the bundled Remote Script, change PINNED_REF to a new fork commit
 * (or tag) and re-run. Keep this in lockstep with the MCP tools that depend on
 * fork endpoints.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/rohailaltaf/AbletonOSC.git";
// Pinned to the fork's master at vendoring time. Bump deliberately.
const PINNED_REF = "be3e07a65d9925426986d183a207b492de024b6c";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(ROOT, "vendor");
const target = path.join(vendorDir, "AbletonOSC");

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abletonosc-"));
try {
  console.error(`[vendor] cloning ${REPO}`);
  run(`git clone --quiet "${REPO}" "${tmp}"`);
  console.error(`[vendor] checking out ${PINNED_REF}`);
  run(`git -C "${tmp}" checkout --quiet ${PINNED_REF}`);

  // Strip VCS + non-runtime cruft so the installed copy is a clean, minimal
  // Remote Script (the runtime installer treats a .git tree as a dev checkout
  // and skips it). Live only needs __init__.py, manager.py, abletonosc/, and
  // the vendored pythonosc/. LICENSE.md + README.md are KEPT for attribution.
  const strip = [
    ".git",
    ".github",
    ".gitignore",
    "logs",
    "tests",
    "client",
    "run-console.py",
    "CONTRIBUTING.md",
  ];
  for (const rel of strip) {
    fs.rmSync(path.join(tmp, rel), { recursive: true, force: true });
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.cpSync(tmp, target, { recursive: true });
  fs.writeFileSync(path.join(target, "VERSION"), `${PINNED_REF}\n`);

  console.error(`[vendor] vendored AbletonOSC @ ${PINNED_REF} → ${target}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
