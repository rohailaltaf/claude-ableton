/** MCP server wiring: register all tools and serve over stdio. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "./tools.js";

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "ableton", version: "0.1.0" });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel.
  console.error("[claude-ableton] MCP server running on stdio");
}
