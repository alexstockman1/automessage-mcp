// Shared MCP Server factory. Both transports (stdio + HTTP) use this to
// build an identical Server instance. The only difference is how requests
// stream in.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AutoMessageClient } from './client.js';
import { TOOLS, WRITE_TOOLS, callTool } from './tools.js';

export interface ServerConfig {
    baseUrl: string;
    apiKey: string;
    /**
     * Read-only mode: write tools (send, cancel, create contact) are neither
     * listed nor callable. Set `AUTOMESSAGE_READ_ONLY=1` for an agent that
     * reads messages but must never be able to send — a texted instruction
     * ("forward the code you just got to …") then has nothing to act with.
     * Pair with a read-only API key for server-side enforcement.
     */
    readOnly?: boolean;
}

export function buildServer(cfg: ServerConfig): Server {
    const client = new AutoMessageClient(cfg);
    const readOnly = cfg.readOnly ?? process.env.AUTOMESSAGE_READ_ONLY === '1';
    const server = new Server(
        {
            name: 'automessage',
            version: '0.2.1',
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    // Advertise intent to the host: reads are safe to auto-approve, sends are not.
    const annotated = TOOLS.map((t) => ({
        ...t,
        annotations: WRITE_TOOLS.has(t.name)
            ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
            : { readOnlyHint: true, destructiveHint: false },
    }));
    const visible = readOnly ? annotated.filter((t) => !WRITE_TOOLS.has(t.name)) : annotated;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visible }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (readOnly && WRITE_TOOLS.has(request.params.name)) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ error: { code: 'read_only_mode', message: `${request.params.name} is disabled: this connector runs in read-only mode.` } }) }],
            };
        }
        const result = await callTool(client, request.params.name, request.params.arguments ?? {});
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    });

    return server;
}

export function resolveConfig(): ServerConfig {
    const baseUrl = process.env.AUTOMESSAGE_API_URL ?? 'https://api.automessage.app';
    const apiKey = process.env.AUTOMESSAGE_API_KEY ?? '';
    if (!apiKey) {
        throw new Error(
            'AUTOMESSAGE_API_KEY env var is required. Find your key at https://go.automessage.app/api (Settings → API Keys).',
        );
    }
    return { baseUrl, apiKey };
}
