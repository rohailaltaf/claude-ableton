/**
 * Offline smoke test: spawn the built MCP server over stdio and list its tools.
 * Does not require Ableton (the OSC client is created lazily on first tool call).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
tools.sort((a, b) => a.name.localeCompare(b.name));
console.log(`TOOL COUNT: ${tools.length}`);
for (const t of tools) console.log(`- ${t.name}`);

await client.close();
process.exit(0);
