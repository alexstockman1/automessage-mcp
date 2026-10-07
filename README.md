# @stockmandigital/automessage-mcp

Model Context Protocol (MCP) server for [autoMessage](https://go.automessage.app). Gives Claude, Cursor, Cline, Codex, and any MCP-compatible client the ability to send and read iMessages from the user's Mac.

Under the hood, this server is a thin shim over autoMessage's REST API. Every tool call resolves to one HTTP request against `https://automessage-api-…run.app/v1/*` with the user's API key. The actual iMessage send happens on the user's Mac via the autoMessage Mac connector, which picks up drafts from Firestore and dispatches via AppleScript through Messages.app.

## Tools exposed

| Tool | Purpose |
|---|---|
| `send_imessage` | Queue an outbound iMessage to a phone number or email. Returns a draft id. If the new-outreach limit (rolling 24h) is reached the message is still accepted and held (`meta.queued.resumesAt` = earliest time a slot frees). |
| `list_conversations` | List the user's iMessage conversations, newest first. |
| `get_conversation_history` | Read message history for a specific conversation. |
| `list_drafts` | Read pending / sent / failed drafts. |
| `get_draft_status` | Check a draft's lifecycle `status` (queued / sending / held / blocked / sent / failed / cancelled) and any `hold` reason. |
| `cancel_pending_draft` | Cancel a queued draft before the Mac connector dispatches it. |
| `list_contacts` | List the user's saved iMessage contacts. |
| `find_contact` | Substring search across contacts (name / phone / email). |
| `create_contact` | Create or upsert a contact. |
| `agent_online_check` | Health check + Mac connector online indicator. |

## Install — Claude Code (stdio)

```bash
claude mcp add automessage --scope user -- \
  env AUTOMESSAGE_API_KEY=<your-key> npx -y @stockmandigital/automessage-mcp
```

Find your API key in the [autoMessage dashboard](https://go.automessage.app) under Settings → API.

Once registered, the tools auto-load in any Claude Code session. Try:

> Use the automessage tool to text my partner that I'm running 10 minutes late.

## Install — Claude Desktop (HTTP / custom connector)

Add a custom connector pointing at `https://automessage-mcp-…run.app/mcp` with the `X-API-KEY` header set to your key. (Hosted deployment of the HTTP transport is part of the autoMessage Cloud Run infrastructure.)

## Install — Cursor, Cline, Codex, etc.

These speak the standard MCP stdio protocol. Configure them with:
- Command: `npx`
- Args: `-y @stockmandigital/automessage-mcp`
- Env: `AUTOMESSAGE_API_KEY=<your-key>`

## Local dev

```bash
npm install
AUTOMESSAGE_API_KEY=<your-key> npm run dev          # stdio with hot reload
AUTOMESSAGE_API_KEY=<your-key> PORT=8090 npm run dev:http   # HTTP locally
```

Test the stdio server with a hand-rolled MCP session:

```bash
AUTOMESSAGE_API_KEY=<key> node dist/stdio.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"agent_online_check","arguments":{}}}
EOF
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│   Claude Code / Cursor / Codex / Claude Desktop / browser bot   │
│                                                                  │
│   tool call: send_imessage { to: "+14155551234", body: "Hi" }   │
└───────────────────────┬──────────────────────────────────────────┘
                        │ stdio JSON-RPC  OR  HTTPS POST /mcp
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  automessage-mcp  (this package)                                │
│                                                                  │
│  Maps tool calls → REST endpoints. Forwards user's API key.     │
└───────────────────────┬──────────────────────────────────────────┘
                        │ HTTPS X-API-KEY → /v1/drafts (etc.)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloud Run REST API  (hosted by autoMessage — not in this repo) │
│                                                                  │
│  Authenticates the API key → writes a draft to Firestore        │
└───────────────────────┬──────────────────────────────────────────┘
                        │ Firestore snapshot listener
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Mac connector  (the autoMessage Mac app — not in this repo)    │
│                                                                  │
│  Picks up draft, sends via AppleScript through Messages.app,    │
│  confirms via chat.db GUID match, updates draft sent=true.      │
└─────────────────────────────────────────────────────────────────┘
```

## Why this matters

LLMs today struggle with "actually contact a real person through iMessage." Twilio + SMS exists but uses a *different* phone number, costs per-message, and arrives as a green-bubble SMS rather than blue-bubble iMessage. autoMessage + MCP closes the gap: any agent that speaks MCP can text from the user's real iMessage number, with conversation history, contact resolution, and reply webhooks all available as tools.

Any agent that speaks MCP can text from the user's real iMessage number, with conversation history, contact resolution and reply webhooks all available as tools.

## License

MIT

## Security notes (2026-10-06)

- **Auth is header-only.** Pass the key as `X-API-KEY: <key>` or `Authorization: Bearer <key>`. The former `?key=` URL form was removed: Cloud Run logs full request URLs, so a key in the query string was recoverable from logs. For Claude's "custom connector" dialog use the stdio package (`claude mcp add … env AUTOMESSAGE_API_KEY=…`) or a client that sets headers.
- **Sessions are bound to the key.** A `Mcp-Session-Id` only works with the key that created it; ids are server-generated. End a session with `DELETE /mcp`.
- **Read-only mode.** Start with `AUTOMESSAGE_READ_ONLY=1` to hide and block `send_imessage`, `cancel_pending_draft` and `create_contact`. Use it for any agent that reads messages but must never be able to send — a texted instruction then has nothing to act with. For server-side enforcement generate a **read-only API key** in the dashboard (`403 read_only_key` on any write).
- Tool annotations: reads carry `readOnlyHint: true`; sends carry `destructiveHint: true` so hosts can require confirmation.
- **Testable transport.** `src/http.ts` exports `createMcpHttpApp({ baseUrl, maxSessions, sessionTtlMs, rateLimit, readOnly })`; the process only listens when the file is the entrypoint. autoMessage's own suite mounts it in-process against the real REST app on the Firestore emulator (auth, session binding, LRU eviction, read-only mode, body-parser envelope). `MCP_MAX_SESSIONS` overrides the 500-session cap. Malformed JSON / oversize bodies / unknown paths answer in the JSON error envelope, never an HTML page.
