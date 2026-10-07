// Thin HTTP client over the autoMessage Cloud Run REST API.
//
// One file. No SDK, no codegen — just `fetch`. Keeps the MCP server's
// bundle size tiny so `npx -y @stockmandigital/automessage-mcp` stays fast.

export interface ClientConfig {
    /** Base URL of the autoMessage Cloud Run API. */
    baseUrl: string;
    /** User's API key (the `xapikey` field on their /users doc). */
    apiKey: string;
    /** Optional fetch override for testing. */
    fetchImpl?: typeof fetch;
}

export class AutoMessageClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly fetchImpl: typeof fetch;

    constructor(cfg: ClientConfig) {
        // Trim trailing slash so route joins don't double up.
        this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
        this.apiKey = cfg.apiKey;
        this.fetchImpl = cfg.fetchImpl ?? fetch;
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const init: RequestInit = {
            method,
            headers: {
                'X-API-KEY': this.apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        };
        if (body !== undefined) init.body = JSON.stringify(body);

        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        let parsed: unknown = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new ApiError(res.status, 'non_json_response', text.slice(0, 200));
            }
        }
        if (!res.ok) {
            const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
            throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
        }
        return parsed as T;
    }

    // ---- Conversations -------------------------------------------------

    listConversations(opts: {
        limit?: number; participant?: string; name?: string; handle?: string;
        group?: boolean; unread?: boolean; activeSince?: string;
        activeBefore?: string; cursor?: string;
    } = {}): Promise<{ data: unknown[]; pagination?: unknown }> {
        const qs = new URLSearchParams();
        qs.set('limit', String(opts.limit ?? 50));
        if (opts.participant) qs.set('participant', opts.participant);
        if (opts.name) qs.set('name', opts.name);
        if (opts.handle) qs.set('handle', opts.handle);
        if (opts.group !== undefined) qs.set('group', String(opts.group));
        if (opts.unread) qs.set('unread', 'true');
        if (opts.activeSince) qs.set('activeSince', opts.activeSince);
        if (opts.activeBefore) qs.set('activeBefore', opts.activeBefore);
        if (opts.cursor) qs.set('cursor', opts.cursor);
        return this.request('GET', `/v1/conversations?${qs}`);
    }

    listRecentMessages(opts: {
        limit?: number; cursor?: string;
        direction?: 'inbound' | 'outbound'; since?: string; before?: string;
    } = {}): Promise<{ data: unknown[]; pagination?: unknown }> {
        const qs = new URLSearchParams();
        qs.set('limit', String(opts.limit ?? 50));
        if (opts.cursor) qs.set('cursor', opts.cursor);
        if (opts.direction) qs.set('direction', opts.direction);
        if (opts.since) qs.set('since', opts.since);
        if (opts.before) qs.set('before', opts.before);
        return this.request('GET', `/v1/messages?${qs}`);
    }

    getConversation(guid: string): Promise<{ data: unknown }> {
        return this.request('GET', `/v1/conversations/${encodeURIComponent(guid)}`);
    }

    listMessages(conversationGuid: string, opts: {
        limit?: number; cursor?: string;
        direction?: 'inbound' | 'outbound'; since?: string; before?: string;
    } = {}): Promise<{ data: unknown[]; pagination?: unknown }> {
        const qs = new URLSearchParams();
        qs.set('limit', String(opts.limit ?? 50));
        if (opts.cursor) qs.set('cursor', opts.cursor);
        if (opts.direction) qs.set('direction', opts.direction);
        if (opts.since) qs.set('since', opts.since);
        if (opts.before) qs.set('before', opts.before);
        return this.request('GET', `/v1/conversations/${encodeURIComponent(conversationGuid)}/messages?${qs}`);
    }

    // ---- Drafts (the write surface) ------------------------------------

    sendMessage(args: {
        to: string;
        body: string;
        responseWebhook?: { url: string; events?: string[]; expiresAfter?: string };
    }): Promise<{ data: unknown; meta?: unknown }> {
        return this.request('POST', '/v1/drafts', args);
    }

    listDrafts(opts: { status?: string; sent?: boolean; sendError?: boolean; limit?: number } = {}): Promise<{ data: unknown[] }> {
        const qs = new URLSearchParams();
        if (opts.status) qs.set('status', opts.status);
        if (opts.sent !== undefined) qs.set('sent', String(opts.sent));
        if (opts.sendError) qs.set('sendError', 'true');
        qs.set('limit', String(opts.limit ?? 50));
        return this.request('GET', `/v1/drafts?${qs}`);
    }

    getDraft(id: string): Promise<{ data: unknown }> {
        return this.request('GET', `/v1/drafts/${encodeURIComponent(id)}`);
    }

    updateDraft(id: string, patch: { to?: string; body?: string; responseWebhook?: unknown }): Promise<{ data: unknown }> {
        return this.request('PATCH', `/v1/drafts/${encodeURIComponent(id)}`, patch);
    }

    cancelDraft(id: string): Promise<void> {
        return this.request('DELETE', `/v1/drafts/${encodeURIComponent(id)}`);
    }

    // ---- Messages (read-only) ------------------------------------------

    getMessage(guid: string): Promise<{ data: unknown }> {
        return this.request('GET', `/v1/messages/${encodeURIComponent(guid)}`);
    }

    // ---- Contacts ------------------------------------------------------

    listContacts(limit = 200): Promise<{ data: unknown[] }> {
        return this.request('GET', `/v1/contacts?limit=${encodeURIComponent(limit)}`);
    }

    upsertContact(contact: {
        phone_number?: string;
        email?: string;
        display_name?: string;
        photo_url?: string;
        url1?: string;
    }): Promise<{ data: unknown }> {
        return this.request('POST', '/v1/contacts', contact);
    }

    getContact(id: string): Promise<{ data: unknown }> {
        return this.request('GET', `/v1/contacts/${encodeURIComponent(id)}`);
    }

    updateContact(id: string, patch: Record<string, unknown>): Promise<{ data: unknown }> {
        return this.request('PATCH', `/v1/contacts/${encodeURIComponent(id)}`, patch);
    }

    deleteContact(id: string): Promise<void> {
        return this.request('DELETE', `/v1/contacts/${encodeURIComponent(id)}`);
    }

    // ---- Status --------------------------------------------------------

    getStatus(): Promise<{ data: unknown }> {
        return this.request('GET', '/v1/status');
    }
}

export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(`[${status} ${code}] ${message}`);
        this.name = 'ApiError';
    }
}
