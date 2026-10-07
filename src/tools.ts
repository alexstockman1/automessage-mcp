// Tool definitions for the autoMessage MCP server.
//
// Each tool is a thin wrapper over the `AutoMessageClient` REST methods,
// with input schemas designed for LLMs to call naturally. JSON Schemas use
// snake_case (idiomatic in MCP tool specs) while internally mapping to the
// REST API's camelCase / snake_case mix.

import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { AutoMessageClient, ApiError } from './client.js';

/** Tools that change state or send messages — hidden/blocked in read-only mode. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['send_imessage', 'cancel_pending_draft', 'create_contact']);

export const TOOLS: Tool[] = [
    {
        name: 'send_imessage',
        description:
            'Send an iMessage from the user\'s Mac. Creates a draft that the user\'s Mac agent picks up and dispatches via Messages.app. Returns the draft id; use get_draft_status to confirm delivery. The recipient must be a valid phone number in E.164 format (+14155551234) or an email address that the recipient uses for iMessage. If the user\'s new-outreach limit is reached (N unreplied conversations messaged in a rolling 24-hour window), the message is STILL ACCEPTED and queued: the response carries meta.queued (reason, limit, used, resumesAt = earliest moment a slot frees) and the draft\'s status is "held" until earlier sends age out of the window or the user raises the limit in Settings — tell the user it is queued, not failed. A 403 recipient_opted_out means the recipient texted STOP: do not retry.',
        inputSchema: {
            type: 'object',
            required: ['to', 'body'],
            properties: {
                to: {
                    type: 'string',
                    description: 'Recipient phone (E.164, e.g. "+14155551234") or email address.',
                },
                body: {
                    type: 'string',
                    description: 'Message body. Max 4096 characters.',
                },
                response_webhook_url: {
                    type: 'string',
                    description:
                        'Optional. HTTPS URL that will receive POST notifications when the recipient replies in this conversation. Persists across the conversation thread, not just the single send.',
                },
                response_webhook_events: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Optional. Subset of events the webhook subscribes to. Defaults to all events. Common values: "message_received".',
                },
            },
        },
    },
    {
        name: 'list_conversations',
        description:
            'Find the user\'s iMessage conversations, ordered by most recently active. Each has a GUID you pass to other tools. To find conversations with a phone number, use `participant` (matches 1:1 AND group chats; loosely-formatted numbers are normalized). Use `name` to search by contact/group name. Pass at most ONE of participant, handle, name, group, or unread; all accept active_since/active_before, limit, and cursor.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Max number of conversations to return (1-200). Default 50.',
                },
                participant: {
                    type: 'string',
                    description: 'Phone number or email that appears in the conversation — returns every thread (1:1 AND group) that includes this contact. Accepts loose formats like "(415) 555-1234"; normalized to E.164 automatically. Best way to find "conversations with this number".',
                },
                name: {
                    type: 'string',
                    description: 'Case-insensitive substring of the contact or group display name (e.g. "sam" matches "Sam Rivera"). Searches your most recent conversations.',
                },
                handle: {
                    type: 'string',
                    description: 'Exact recipient handle (E.164 phone like +14125551234, or email) — returns only the 1:1 conversation with that contact. Prefer `participant` unless you specifically want the 1:1 thread.',
                },
                group: {
                    type: 'boolean',
                    description: 'true: group chats only. false: 1:1 conversations only. Omit for both.',
                },
                unread: {
                    type: 'boolean',
                    description: 'true: only conversations with unread messages.',
                },
                active_since: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only conversations active at or after this time.',
                },
                active_before: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only conversations last active before this time.',
                },
                cursor: {
                    type: 'string',
                    description: 'Pagination cursor from a previous response\'s pagination.nextCursor. Omit for the first page.',
                },
            },
        },
    },
    {
        name: 'get_conversation_history',
        description:
            'Return the message history of a single conversation, ordered newest first. Useful for catching up on a thread, summarizing, or extracting context before drafting a reply.',
        inputSchema: {
            type: 'object',
            required: ['conversation_guid'],
            properties: {
                conversation_guid: {
                    type: 'string',
                    description: 'GUID of the conversation (from list_conversations).',
                },
                limit: {
                    type: 'number',
                    description: 'Max number of messages to return (1-200). Default 50.',
                },
                cursor: {
                    type: 'string',
                    description: 'ISO-8601 sentDate cursor from a previous page response. Returns messages older than this date.',
                },
                direction: {
                    type: 'string',
                    enum: ['inbound', 'outbound'],
                    description: 'Only messages received (inbound) or sent (outbound).',
                },
                since: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only messages sent at or after this time.',
                },
                before: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only messages sent before this time.',
                },
            },
        },
    },
    {
        name: 'list_recent_messages',
        description:
            'Most recent messages ACROSS ALL conversations, newest first — ideal for "catch me up" or "what did I miss today". Filter by direction and time window; paginate with cursor.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Max number of messages to return (1-200). Default 50.',
                },
                cursor: {
                    type: 'string',
                    description: 'ISO-8601 sentDate cursor from a previous page response.',
                },
                direction: {
                    type: 'string',
                    enum: ['inbound', 'outbound'],
                    description: 'Only messages received (inbound) or sent (outbound).',
                },
                since: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only messages sent at or after this time.',
                },
                before: {
                    type: 'string',
                    description: 'ISO-8601 timestamp — only messages sent before this time.',
                },
            },
        },
    },
    {
        name: 'list_drafts',
        description:
            'List outbound drafts. Useful for checking what\'s queued for the Mac agent, what is held by the new-outreach limit, what was recently sent, or what failed. By default returns drafts in any state; filter with status (preferred), or sent / send_error.',
        inputSchema: {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    enum: ['queued', 'sending', 'held', 'blocked', 'sent', 'cancelled', 'failed'],
                    description: 'Filter on lifecycle status. "held" = parked by the new-outreach limit (resumes on its own); "blocked" = subscription_required / recipient_opted_out.',
                },
                sent: { type: 'boolean', description: 'Filter: true = delivered/cancelled, false = pending dispatch.' },
                send_error: { type: 'boolean', description: 'Filter: true = drafts that failed to send (held drafts are not failures and are excluded).' },
                // (status filter above is preferred)
                limit: { type: 'number', description: 'Max number of drafts (1-200). Default 50.' },
            },
        },
    },
    {
        name: 'get_draft_status',
        description:
            'Read a single draft. Use this after send_imessage to confirm the message was delivered. The response includes `status` — queued (waiting for the Mac), sending, held (parked by the new-outreach limit — rolling 24h window; resumes automatically as earlier sends age out or when the user raises the limit — NOT a failure), blocked (`hold.reason`: subscription_required or recipient_opted_out; never auto-retried), sent, cancelled, failed — plus `hold` (reason/since/message), `sent`, `sendError` (failed/cancelled only), and `sentMessage` (Firestore doc path of the dispatched message).',
        inputSchema: {
            type: 'object',
            required: ['draft_id'],
            properties: {
                draft_id: { type: 'string', description: 'Draft id returned from send_imessage.' },
            },
        },
    },
    {
        name: 'cancel_pending_draft',
        description:
            'Soft-cancel a pending draft before the Mac agent dispatches it. Only works while the draft is still `sent: false`. Once sent, this returns 409 Conflict.',
        inputSchema: {
            type: 'object',
            required: ['draft_id'],
            properties: {
                draft_id: { type: 'string', description: 'Draft id to cancel.' },
            },
        },
    },
    {
        name: 'list_contacts',
        description:
            'List the user\'s saved iMessage contacts. Contacts are auto-populated by the Mac agent from macOS Contacts as the user messages people, plus any manual additions. Useful for resolving "Sarah" to a phone number before sending.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Max contacts to return (1-500). Default 200.' },
            },
        },
    },
    {
        name: 'find_contact',
        description:
            'Search the user\'s contacts by display name, phone, or email. Returns the closest matches by case-insensitive substring. Use this when the user references someone by name to resolve them to a sendable phone/email handle.',
        inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
                query: { type: 'string', description: 'Free-text search: name, phone, or email substring.' },
                limit: { type: 'number', description: 'Max matches to return. Default 10.' },
            },
        },
    },
    {
        name: 'create_contact',
        description:
            'Create or upsert a contact. Use when the user asks to "save" a new person to their address book. Requires at least one of phone_number or email. Note: this is a one-way edit — changes here do not propagate to the user\'s native macOS/iOS Contacts.',
        inputSchema: {
            type: 'object',
            properties: {
                phone_number: { type: 'string', description: 'Phone in E.164 (+14155551234).' },
                email: { type: 'string', description: 'Email address.' },
                display_name: { type: 'string', description: 'Friendly name for the contact.' },
                photo_url: { type: 'string', description: 'Optional URL or data: URL for an avatar image.' },
            },
        },
    },
    {
        name: 'agent_online_check',
        description:
            'Check whether the user\'s Mac agent is currently running and able to dispatch iMessages. If `online: false`, any send_imessage call will queue the draft but it won\'t dispatch until the Mac comes back online.',
        inputSchema: { type: 'object', properties: {} },
    },
];

// ---- Tool dispatcher --------------------------------------------------

export async function callTool(client: AutoMessageClient, name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
        switch (name) {
            case 'send_imessage': {
                const webhook = typeof args['response_webhook_url'] === 'string' && args['response_webhook_url']
                    ? {
                        url: args['response_webhook_url'] as string,
                        ...(Array.isArray(args['response_webhook_events'])
                            ? { events: args['response_webhook_events'] as string[] }
                            : {}),
                    }
                    : undefined;
                const res = await client.sendMessage({
                    to: String(args['to']),
                    body: String(args['body']),
                    ...(webhook ? { responseWebhook: webhook } : {}),
                });
                return res;
            }
            case 'list_conversations':
                return await client.listConversations({
                    limit: numberArg(args['limit'], 50),
                    ...(typeof args['participant'] === 'string' ? { participant: args['participant'] as string } : {}),
                    ...(typeof args['name'] === 'string' ? { name: args['name'] as string } : {}),
                    ...(typeof args['handle'] === 'string' ? { handle: args['handle'] as string } : {}),
                    ...(typeof args['group'] === 'boolean' ? { group: args['group'] as boolean } : {}),
                    ...(args['unread'] === true ? { unread: true } : {}),
                    ...(typeof args['active_since'] === 'string' ? { activeSince: args['active_since'] as string } : {}),
                    ...(typeof args['active_before'] === 'string' ? { activeBefore: args['active_before'] as string } : {}),
                    ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] as string } : {}),
                });
            case 'get_conversation_history':
                return await client.listMessages(String(args['conversation_guid']), {
                    limit: numberArg(args['limit'], 50),
                    ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] as string } : {}),
                    ...(args['direction'] === 'inbound' || args['direction'] === 'outbound'
                        ? { direction: args['direction'] as 'inbound' | 'outbound' } : {}),
                    ...(typeof args['since'] === 'string' ? { since: args['since'] as string } : {}),
                    ...(typeof args['before'] === 'string' ? { before: args['before'] as string } : {}),
                });
            case 'list_recent_messages':
                return await client.listRecentMessages({
                    limit: numberArg(args['limit'], 50),
                    ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] as string } : {}),
                    ...(args['direction'] === 'inbound' || args['direction'] === 'outbound'
                        ? { direction: args['direction'] as 'inbound' | 'outbound' } : {}),
                    ...(typeof args['since'] === 'string' ? { since: args['since'] as string } : {}),
                    ...(typeof args['before'] === 'string' ? { before: args['before'] as string } : {}),
                });
            case 'list_drafts':
                return await client.listDrafts({
                    ...(typeof args['status'] === 'string' ? { status: args['status'] as string } : {}),
                    ...(typeof args['sent'] === 'boolean' ? { sent: args['sent'] as boolean } : {}),
                    ...(args['send_error'] === true ? { sendError: true } : {}),
                    limit: numberArg(args['limit'], 50),
                });
            case 'get_draft_status':
                return await client.getDraft(String(args['draft_id']));
            case 'cancel_pending_draft':
                await client.cancelDraft(String(args['draft_id']));
                return { cancelled: true };
            case 'list_contacts':
                return await client.listContacts(numberArg(args['limit'], 200));
            case 'find_contact': {
                const all = await client.listContacts(500);
                const q = String(args['query']).toLowerCase().trim();
                const limit = numberArg(args['limit'], 10);
                if (!q) return { data: [] };
                const matched = (all.data as Array<Record<string, unknown>>).filter((c) => {
                    return Object.values(c).some(
                        (v) => typeof v === 'string' && v.toLowerCase().includes(q),
                    );
                });
                return { data: matched.slice(0, limit) };
            }
            case 'create_contact':
                return await client.upsertContact({
                    ...(typeof args['phone_number'] === 'string' ? { phone_number: args['phone_number'] as string } : {}),
                    ...(typeof args['email'] === 'string' ? { email: args['email'] as string } : {}),
                    ...(typeof args['display_name'] === 'string' ? { display_name: args['display_name'] as string } : {}),
                    ...(typeof args['photo_url'] === 'string' ? { photo_url: args['photo_url'] as string } : {}),
                });
            case 'agent_online_check':
                return await client.getStatus();
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (err) {
        if (err instanceof ApiError) {
            return { error: { code: err.code, status: err.status, message: err.message } };
        }
        throw err;
    }
}

function numberArg(v: unknown, fallback: number): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const n = Number.parseInt(v, 10);
        if (!Number.isNaN(n)) return n;
    }
    return fallback;
}
