#!/usr/bin/env node
import { createMcpServer } from "../dist/mcp/server.mjs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = createMcpServer({
  baseUrl: process.env.KNOWLEDGE_API_URL || "http://localhost:8421",
  token: process.env.KNOWLEDGE_API_TOKEN,
});
server.connect(new StdioServerTransport()).catch(() => {
  console.error("Knowledge MCP connection failed");
  process.exitCode = 1;
});
