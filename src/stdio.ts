#!/usr/bin/env node
// stdio transport — for Claude Code, Cursor, Cline, and any MCP client that
// speaks the standard stdio protocol.
//
// Install for Claude Code:
//   claude mcp add automessage --scope user -- env AUTOMESSAGE_API_KEY=<key> npx -y @stockmandigital/automessage-mcp

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, resolveConfig } from './server.js';

async function main() {
    const cfg = resolveConfig();
    const server = buildServer(cfg);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stderr-only logging to avoid corrupting the JSON-RPC stream on stdout.
    process.stderr.write(
        `automessage-mcp v0.2.0 connected via stdio (baseUrl=${cfg.baseUrl})\n`,
    );
}

main().catch((err) => {
    process.stderr.write(`automessage-mcp failed to start: ${(err as Error).message}\n`);
    process.exit(1);
});
