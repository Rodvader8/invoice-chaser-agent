import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../mcp/server.js";
import { connect } from "./common.js";

/** The read-only MCP server over stdio. stdout carries the protocol only; logs go to stderr. */
const conn = await connect();
const server = buildMcpServer({ accounting: conn.accounting, jobs: conn.jobs });
await server.connect(new StdioServerTransport());
process.stderr.write("invoice-chaser MCP server ready (stdio, read only)\n");
