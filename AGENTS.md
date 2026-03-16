# AGENTS.md — openclaw-status

OpenClaw plugin for Status App communities. Sends and receives messages in Status communities via Waku protocol using status-backend.

**Stack:** TypeScript, Node.js, OpenClaw Plugin SDK, status-backend (Go binary).

## Development Setup

```bash
npm install
npm run build         # compile TypeScript
npm run dev           # watch mode
npm run lint          # type-check only
```

## Architecture

```
OpenClaw Agent
    ↓ registerTool()
src/index.ts           — plugin entry, registers tools
src/status-client.ts   — HTTP + WebSocket client for status-backend
skills/status/SKILL.md — agent playbook
    ↓ HTTP/WS
status-backend (Go, port 12345)
    ↓ Waku P2P
Status Community
```

## Plugin Structure

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest, configSchema |
| `src/index.ts` | Plugin entry — `register(api)`, tool registration |
| `src/status-client.ts` | TypeScript port of `status_client.py` |
| `skills/status/SKILL.md` | Agent playbook |

## Registered Tools

| Tool | Description |
|------|-------------|
| `status_get_communities` | List joined communities |
| `status_get_messages` | Fetch recent messages from a channel |
| `status_send_message` | Send a text message to a channel |

## Config (openclaw.json `plugins.openclaw-status`)

| Key | Default | Description |
|-----|---------|-------------|
| `backendUrl` | `http://127.0.0.1:12345` | status-backend URL |
| `keyUID` | — | Account key UID for re-login |
| `password` | — | **Required.** Account password |
| `dataDir` | `~/.openclaw/data/openclaw-status` | Data directory |
| `displayName` | `OpenClaw` | Display name (first account creation only) |

## status-backend Startup Sequence

**Critical — must follow this order:**

1. WebSocket connect to `/signals`
2. `POST /statusgo/InitializeApplication`
3. `POST /statusgo/CreateAccountAndLogin` (first time) OR `POST /statusgo/LoginAccount` (re-login using keyUID)
4. Wait for `node.login` signal
5. `CallRPC wakuext_startMessenger`
6. Wait for startMessenger to complete (~10 min on first launch)
7. Only then: other RPC calls work

## Key Gotchas (from status-app-agent experience)

- **`startMessenger` takes ~10 min** on first launch (Waku peer discovery). Must be called async, never block UI.
- **WebSocket ping** — status-backend doesn't respond to WS pings. Disable keepalive/ping in WS client.
- **RPC blocks during startMessenger** — all `CallRPC` calls queue behind it.
- **JSON-RPC `id` is required** — omitting causes empty/error responses.
- **`LoginAccount` on running node** — causes crash. Check `settings_getSettings` first; if it returns a public-key, skip login.
- **Waku P2P between two nodes on same machine** — community membership operations may not deliver. Run bot on a separate host for testing.
- **Account = ECDSA keypair** from BIP39 mnemonic. Store `keyUID` in config for re-login.

## Related Projects

- `status-app-agent` — original Python bot (reference implementation for status-backend integration patterns)
- `openclaw-youtube` — reference for OpenClaw plugin structure

## Roadmap

- **v0.1 (current):** Tool-only plugin — agent can read/send messages via registered tools
- **v0.2:** Background service — listen for incoming messages, notify agent
- **v0.3:** Channel plugin — Status as a full OpenClaw messaging channel (users interact from Status App)
