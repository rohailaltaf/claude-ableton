/** Shared client singleton + small helpers used by every tool. */

import { AbletonClient, i, type OscValue } from "./osc.js";

let client: AbletonClient | null = null;
let pinged = false;

/**
 * Lazily create the OSC client and ping the bridge once (mirrors the Python
 * server's `_get_client`). Throws BridgeUnreachable on the first call if Live
 * isn't reachable.
 */
export async function getClient(): Promise<AbletonClient> {
  if (!client) client = new AbletonClient();
  if (!pinged) {
    await client.pingOrRaise();
    pinged = true;
  }
  return client;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a track's device count: `/live/track/get/num_devices` → (track, num). */
export async function numDevices(
  c: AbletonClient,
  trackIndex: number,
): Promise<number> {
  const reply = await c.query("/live/track/get/num_devices", [i(trackIndex)]);
  return Number(reply[1]);
}

// --- OscValue casting helpers ---------------------------------------------

export const asNum = (v: OscValue): number => Number(v);
export const asStr = (v: OscValue): string => String(v);
export const asBool = (v: OscValue): boolean =>
  typeof v === "boolean" ? v : Number(v) !== 0;

// --- MCP result helper ----------------------------------------------------

export interface ToolResult {
  content: { type: "text"; text: string }[];
  [key: string]: unknown;
}

/** Wrap a JSON-serializable value as an MCP text result. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
