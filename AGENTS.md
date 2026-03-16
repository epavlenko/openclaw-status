# AGENTS.md — openclaw-status

OpenClaw channel plugin for Status App communities. Sends and receives messages privately in Status communities via Logos messaging (Waku protocol) using status-backend.

**Stack:** TypeScript, Node.js, OpenClaw Plugin SDK, status-backend (Go binary).

## Development Setup

```bash
npm install
npm run build         # compile TypeScript
npm run dev           # watch mode
npm run test          # run tests (vitest)
npm run lint          # type-check only
```

## Architecture

```
OpenClaw Agent
    ↓ registerChannel()
src/index.ts           — plugin entry, registers channel
src/channel.ts         — ChannelPlugin object (gateway, outbound, config adapters)
src/config.ts          — account types, resolution, defaults
src/runtime.ts         — PluginRuntime store
src/status-client.ts   — HTTP + WebSocket client for status-backend
skills/status/SKILL.md — agent playbook
    ↓ HTTP/WS
status-backend (Go, port 12345)
    ↓ Waku P2P
Status Community
```

### Inbound flow
```
Status Community → Waku → status-backend → WebSocket signal (messages.new)
  → channel.ts gateway.startAccount() listener
  → runtime.channel.reply.handleInboundMessage()
  → OpenClaw agent processes message
```

### Outbound flow
```
OpenClaw agent reply → outbound.sendText()
  → activeClients.get(accountId).client.sendChatMessage()
  → status-backend → Waku → Status Community
```

## Plugin Structure

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest, channels declaration, configSchema |
| `src/index.ts` | Plugin entry — `register(api)`, channel registration |
| `src/channel.ts` | `statusPlugin` — gateway, outbound, config adapters |
| `src/config.ts` | Account types, `resolveStatusAccount()`, `listStatusAccountIds()` |
| `src/runtime.ts` | `getStatusRuntime()` / `setStatusRuntime()` |
| `src/status-client.ts` | TypeScript port of `status_client.py` — HTTP + WS client |
| `skills/status/SKILL.md` | Agent playbook |
| `test/config.test.ts` | Config resolution unit tests |
| `test/channel.test.ts` | Channel plugin contract tests |

## Channel Adapters (v0.1)

| Adapter | Status | Description |
|---------|--------|-------------|
| `config` | ✅ | listAccountIds, resolveAccount, isConfigured, describeAccount |
| `gateway` | ✅ | startAccount — connect, login, listen for messages |
| `outbound` | ✅ | sendText — send messages to community channels |
| `setup` | — | v0.2: onboarding wizard |
| `security` | — | v0.2: channel policies |
| `status` | — | v0.2: health checks |
| `groups` | — | v0.3: community/channel management |
| `messaging` | — | v0.3: target parsing |
| `directory` | — | v0.3: member/channel listing |
| `threading` | — | v0.4: reply threads |
| `actions` | — | v0.4: reactions, edit, delete |

## Config (openclaw.json `channels.status`)

### Flat config (single account)
```json
{
  "channels": {
    "status": {
      "backendUrl": "http://127.0.0.1:12345",
      "password": "your-password",
      "keyUID": "0x...",
      "dataDir": "~/.openclaw/data/openclaw-status",
      "displayName": "OpenClaw"
    }
  }
}
```

### Multi-account config
```json
{
  "channels": {
    "status": {
      "accounts": {
        "prod": {
          "backendUrl": "http://prod:12345",
          "password": "prod-pass",
          "keyUID": "0xabc"
        },
        "staging": {
          "backendUrl": "http://staging:12345",
          "password": "staging-pass"
        }
      }
    }
  }
}
```

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

- **v0.1 (current):** Channel plugin — gateway + outbound + config adapters
- **v0.2:** Setup wizard, Zod validation, health checks
- **v0.3:** Community/channel management, allowlist, directory
- **v0.4:** Rich messaging (threads, reactions, media)
- **v0.5:** DM support, pairing, typing indicators
- **v1.0:** Production ready, marketplace
