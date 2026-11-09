#!/usr/bin/env node
// HTTP transport — for Claude Desktop custom connectors, Claude on web, and
// any MCP client that speaks the Streamable HTTP protocol.
//
// Hosted alongside the Cloud Run REST API. Auth: the same X-API-KEY header
// (or Authorization: Bearer) that the REST API expects; the MCP server passes
// it through to the downstream API for each request.
//
// Audit Tier 2 (2026-10-06):
//   • the `?key=` URL form is GONE — Cloud Run logs the full request URL, so a
//     key in the query string was harvestable from logs (H5);
//   • session ids are always server-minted, and a session is BOUND to the key
//     that created it (hash compare, constant time) — a session id alone is
//     not a credential (M2);
//   • sessions are capped, closed on eviction, and clients can end them with
//     DELETE /mcp; GET /mcp serves the SDK's event stream;
//   • `trust proxy` is 1 (Cloud Run's own hop) so a spoofed X-Forwarded-For
//     cannot dodge the limiter (M1); a tight failed-auth limiter sits on top;
//   • local runs bind 127.0.0.1 unless on Cloud Run (K_SERVICE set).
//
// The app is built by `createMcpHttpApp()` so the test suite can mount it
// in-process (supertest) with a small session cap and no rate limiter; the
// `listen` call only runs when this file is the process entrypoint.
//
// Deployable to Cloud Run via mcp_server/deploy.sh.

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { AutoMessageClient, ApiError } from './client.js';

export const MCP_HTTP_VERSION = '0.2.5';
const DEFAULT_BASE_URL = process.env.AUTOMESSAGE_API_URL ?? 'https://api.automessage.app';

export interface McpHttpOptions {
    /** Downstream REST API the tools call. */
    baseUrl?: string;
    /** Max concurrent sessions before LRU eviction (env MCP_MAX_SESSIONS, default 500). */
    maxSessions?: number;
    /**
     * Max concurrent sessions PER API KEY before that key's least recently
     * used session is evicted (env MCP_MAX_SESSIONS_PER_KEY, default 20).
     * SEC-030 (2026-11-09): one key — or, before the mint-time check below,
     * one anonymous caller — could fill the whole map and evict every other
     * tenant's live session.
     */
    maxSessionsPerKey?: number;
    /** Idle TTL per session (default 30 min). */
    sessionTtlMs?: number;
    /** Per-IP limiters (default on; tests turn them off). */
    rateLimit?: boolean;
    /** Hide + block the write tools (env AUTOMESSAGE_READ_ONLY=1). */
    readOnly?: boolean;
}

interface SessionEntry {
    server: ReturnType<typeof buildServer>;
    transport: StreamableHTTPServerTransport;
    keyHash: Buffer;
    createdAt: number;
    lastSeen: number;
    /** Monotonic use counter — LRU order never ties the way millisecond clocks do. */
    lastUse: number;
    timer: NodeJS.Timeout;
}

export interface McpHttpApp {
    app: Express;
    /** Live session count (tests + diagnostics). */
    sessionCount(): number;
    /** Close every session (tests). */
    closeAll(): Promise<void>;
}

function keyFromRequest(req: Request): string {
    return (req.header('x-api-key') ?? req.header('authorization') ?? '')
        .replace(/^Bearer\s+/i, '')
        .trim();
}

function hashKey(key: string): Buffer {
    return createHash('sha256').update(key, 'utf8').digest();
}

function unauthorized(res: Response, message: string): void {
    res.status(401).json({ error: { code: 'unauthorized', message } });
}

const NEED_KEY = 'Provide your API key via the X-API-KEY header or an Authorization: Bearer token.';

export function createMcpHttpApp(opts: McpHttpOptions = {}): McpHttpApp {
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    const maxSessions = opts.maxSessions ?? Number.parseInt(process.env.MCP_MAX_SESSIONS ?? '500', 10);
    const maxSessionsPerKey = opts.maxSessionsPerKey ?? Number.parseInt(process.env.MCP_MAX_SESSIONS_PER_KEY ?? '20', 10);
    const sessionTtlMs = opts.sessionTtlMs ?? 30 * 60_000;
    const limiters = opts.rateLimit ?? true;
    const readOnly = opts.readOnly ?? process.env.AUTOMESSAGE_READ_ONLY === '1';

    const app = express();
    // Exactly one trusted hop (Cloud Run's front end appends the real client IP
    // as the LAST X-Forwarded-For entry). `true` took the FIRST entry, which the
    // client controls — every request could present a fresh fake IP.
    app.set('trust proxy', 1);
    app.use(helmet());
    if (limiters) {
        // Per-IP throttle. This public (--allow-unauthenticated) endpoint mints a
        // fresh MCP server + transport per new session, so an unthrottled bad-key
        // flood is a memory/CPU DoS even before the downstream REST API rejects
        // the key.
        app.use(
            rateLimit({
                windowMs: 60_000,
                limit: 600,
                standardHeaders: 'draft-7',
                legacyHeaders: false,
                message: { error: { code: 'rate_limited', message: 'Too many requests — slow down.' } },
            }),
        );
        // Failed requests (4xx/5xx) get a much tighter budget — brute-force guard.
        app.use(
            rateLimit({
                windowMs: 60_000,
                limit: 30,
                skipSuccessfulRequests: true,
                standardHeaders: 'draft-7',
                legacyHeaders: false,
                message: { error: { code: 'rate_limited', message: 'Too many failed requests — slow down.' } },
            }),
        );
    }
    // SEC-016 (2026-10-28): no client sends a compressed body; `inflate: false`
    // turns a `Content-Encoding` request into a 415 instead of a parser path that
    // could crash the process (body-parser GHSA-27r3-jxmh-p828).
    app.use(express.json({ limit: '512kb', inflate: false }));

    // Liveness for Cloud Run.
    app.get('/health', (_req, res) => {
        res.status(200).json({ ok: true, service: 'automessage-mcp', version: MCP_HTTP_VERSION });
    });

    app.get('/', (_req, res) => {
        res.status(200).json({
            service: 'automessage-mcp',
            version: MCP_HTTP_VERSION,
            transport: 'Streamable HTTP (MCP)',
            endpoint: '/mcp',
            auth: 'X-API-KEY header or Authorization: Bearer <key> — forwarded to the autoMessage REST API. Keys are never accepted in the URL.',
            readOnly,
            docs: 'https://github.com/alexstockman1/automessage-mcp',
        });
    });

    // ---- MCP HTTP endpoint ---------------------------------------------
    const sessions = new Map<string, SessionEntry>();
    let useCounter = 0;

    async function closeSession(id: string): Promise<void> {
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        clearTimeout(entry.timer);
        try { await entry.transport.close(); } catch { /* already closed */ }
        try { await entry.server.close(); } catch { /* already closed */ }
    }

    function armEviction(id: string, entry: SessionEntry): void {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { void closeSession(id); }, sessionTtlMs);
        entry.timer.unref();
    }

    /** Resolve an existing session the caller is entitled to use, or null. */
    function resolveSession(req: Request, res: Response, key: string): SessionEntry | null | undefined {
        const sessionId = req.header('mcp-session-id');
        if (!sessionId) return undefined;                 // no session requested
        const entry = sessions.get(sessionId);
        if (!entry) {
            res.status(404).json({ error: { code: 'session_not_found', message: 'Unknown or expired Mcp-Session-Id. Initialize again.' } });
            return null;
        }
        const presented = hashKey(key);
        if (presented.length !== entry.keyHash.length || !timingSafeEqual(presented, entry.keyHash)) {
            unauthorized(res, 'This session belongs to a different API key.');
            return null;
        }
        entry.lastSeen = Date.now();
        entry.lastUse = ++useCounter;
        armEviction(sessionId, entry);
        return entry;
    }

    /** Least recently used session id among `candidates` (all sessions when omitted). */
    function lruSessionId(candidates?: Buffer): string | undefined {
        let oldestId: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [id, e] of sessions) {
            if (candidates && (candidates.length !== e.keyHash.length || !timingSafeEqual(candidates, e.keyHash))) continue;
            if (e.lastUse < oldest) { oldest = e.lastUse; oldestId = id; }
        }
        return oldestId;
    }

    /**
     * SEC-030 (2026-11-09): prove the key before minting a session. Until now
     * the transport accepted ANY non-empty key and found out on the first
     * tool call — so an anonymous caller could mint sessions until the LRU
     * cap evicted every real tenant's session, and the failed-auth limiter
     * never saw it (an `initialize` with a bad key was an HTTP 200). One
     * `GET /v1/status` per NEW session: 401 → HTTP 401 here (counted by the
     * failed limiter), nothing minted; the API unreachable → 503, nothing
     * minted (a session that could never work is not worth holding).
     */
    async function keyAccepted(apiKey: string, res: Response): Promise<boolean> {
        try {
            await new AutoMessageClient({ baseUrl, apiKey }).getStatus();
            return true;
        } catch (err) {
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
                unauthorized(res, 'The autoMessage API rejected this API key.');
                return false;
            }
            if (err instanceof ApiError && err.status === 429) {
                res.status(429).json({ error: { code: 'rate_limited', message: 'The autoMessage API is rate limiting this client — retry shortly.' } });
                return false;
            }
            console.error('mcp key check failed', err instanceof ApiError ? `${err.status} ${err.code}` : (err as Error).message);
            res.status(503).json({ error: { code: 'upstream_unavailable', message: 'Could not reach the autoMessage API to verify the key — retry shortly.' } });
            return false;
        }
    }

    app.post('/mcp', async (req: Request, res: Response) => {
        try {
            const apiKey = keyFromRequest(req);
            if (!apiKey) { unauthorized(res, NEED_KEY); return; }

            let entry = resolveSession(req, res, apiKey);
            if (entry === null) return;                   // response already sent
            if (entry === undefined) {
                if (!(await keyAccepted(apiKey, res))) return;   // response already sent
                const keyHash = hashKey(apiKey);
                // Per-key cap first: one key never evicts another tenant's session
                // while it still holds `maxSessionsPerKey` of its own.
                let mine = 0;
                for (const e of sessions.values()) if (e.keyHash.length === keyHash.length && timingSafeEqual(e.keyHash, keyHash)) mine += 1;
                if (mine >= maxSessionsPerKey) {
                    const victim = lruSessionId(keyHash);
                    if (victim) await closeSession(victim);
                }
                if (sessions.size >= maxSessions) {
                    // Evict the least recently used session rather than refusing.
                    const victim = lruSessionId();
                    if (victim) await closeSession(victim);
                }
                const newId = randomUUID();               // never client-chosen
                const server = buildServer({ baseUrl, apiKey, readOnly });
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newId });
                await server.connect(transport);
                const now = Date.now();
                entry = { server, transport, keyHash, createdAt: now, lastSeen: now, lastUse: ++useCounter, timer: setTimeout(() => {}, 0) };
                sessions.set(newId, entry);
                armEviction(newId, entry);
            }

            await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error('mcp request failed', (err as Error).message);
            if (!res.headersSent) {
                res.status(500).json({ error: { code: 'mcp_internal_error', message: 'Internal error handling the MCP request.' } });
            }
        }
    });

    // Event stream for an existing session (SDK Streamable HTTP GET).
    app.get('/mcp', async (req: Request, res: Response) => {
        const apiKey = keyFromRequest(req);
        if (!apiKey) { unauthorized(res, NEED_KEY); return; }
        const entry = resolveSession(req, res, apiKey);
        if (!entry) {
            if (entry === undefined) res.status(400).json({ error: { code: 'missing_session', message: 'Mcp-Session-Id header required.' } });
            return;
        }
        try {
            await entry.transport.handleRequest(req, res);
        } catch (err) {
            console.error('mcp stream failed', (err as Error).message);
            if (!res.headersSent) res.status(500).json({ error: { code: 'mcp_internal_error', message: 'Internal error.' } });
        }
    });

    // Explicit session end.
    app.delete('/mcp', async (req: Request, res: Response) => {
        const apiKey = keyFromRequest(req);
        if (!apiKey) { unauthorized(res, NEED_KEY); return; }
        const entry = resolveSession(req, res, apiKey);
        if (!entry) {
            if (entry === undefined) res.status(400).json({ error: { code: 'missing_session', message: 'Mcp-Session-Id header required.' } });
            return;
        }
        await closeSession(req.header('mcp-session-id')!);
        res.status(204).end();
    });

    // Anything else: uniform JSON 404 (never Express's HTML page).
    app.use((_req, res) => {
        res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found.' } });
    });

    // Body-parser failures (malformed JSON, over-limit body) are the caller's
    // fault → 4xx JSON, never a stack trace.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
        if (res.headersSent) return;
        if (err.type === 'entity.parse.failed') {
            res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
            return;
        }
        if (err.type === 'entity.too.large') {
            res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body exceeds the size limit.' } });
            return;
        }
        // SEC-016: `inflate: false` turns a compressed body into this error.
        if (err.type === 'encoding.unsupported') {
            res.status(415).json({ error: { code: 'unsupported_media_type', message: 'Unsupported request encoding.' } });
            return;
        }
        const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
        console.error('mcp http error', status, err.message);
        res.status(status).json({ error: { code: status === 500 ? 'mcp_internal_error' : 'bad_request', message: status === 500 ? 'Internal error.' : 'Malformed request.' } });
    });

    return {
        app,
        sessionCount: () => sessions.size,
        closeAll: async () => { await Promise.all([...sessions.keys()].map(closeSession)); },
    };
}

// ---- Entrypoint ------------------------------------------------------------
const isMain = (() => {
    try { return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]; }
    catch { return false; }
})();

if (isMain) {
    const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
    const HOST = process.env.HOST ?? (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');
    const { app } = createMcpHttpApp();
    app.listen(PORT, HOST, () => {
        process.stdout.write(
            JSON.stringify({
                severity: 'INFO',
                message: `automessage-mcp listening on ${HOST}:${PORT}`,
                baseUrl: DEFAULT_BASE_URL,
            }) + '\n',
        );
    });
}
