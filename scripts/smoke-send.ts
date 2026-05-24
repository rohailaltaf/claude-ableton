/**
 * Send-only smoke test for the hand-rolled OSC wire format.
 *
 * Runs WITHOUT binding port 11001 (so it coexists with a running Python MCP
 * server), sends a single fire-and-forget command, and exits. Verify the
 * effect through the live MCP read tools.
 *
 * Usage: npx tsx scripts/smoke-send.ts <address> [args...]
 *   numeric args: prefix with "i:" or "f:" to force int/float (default f)
 *   string args:  prefix with "s:" or pass as-is
 * Example: npx tsx scripts/smoke-send.ts /live/song/set/tempo f:128
 */
import { AbletonClient, f, i, type SendArg } from "../src/osc.ts";

const [address, ...rawArgs] = process.argv.slice(2);
if (!address) {
  console.error("usage: smoke-send.ts <address> [i:N | f:N | s:STR ...]");
  process.exit(1);
}

const args: SendArg[] = rawArgs.map((a) => {
  if (a.startsWith("i:")) return i(Number(a.slice(2)));
  if (a.startsWith("f:")) return f(Number(a.slice(2)));
  if (a.startsWith("s:")) return a.slice(2);
  const n = Number(a);
  return Number.isFinite(n) ? f(n) : a;
});

const client = new AbletonClient({ bind: false });
client.send(address, ...args);
console.error(`[smoke] sent ${address} ${JSON.stringify(args)}`);
// Give the datagram time to flush before the process exits.
setTimeout(() => {
  client.close();
  process.exit(0);
}, 200);
