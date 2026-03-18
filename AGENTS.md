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
    ↓ registerChannel() + registerTool()
src/index.ts              — plugin entry, registers channel + status_community tool
src/channel.ts            — ChannelPlugin object (gateway, outbound, config adapters)
src/config.ts             — account types, resolution, defaults
src/community-store.ts    — persistent JSON store for dynamically joined communities
src/setup.ts              — backend provisioning (find/build/start status-backend)
src/runtime.ts            — PluginRuntime store
src/status-client.ts      — HTTP + WebSocket client for status-backend
skills/status/SKILL.md    — agent playbook
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

### Gateway auto-provisioning
```
gateway.startAccount()
  → ensureBackend(url, binaryPath?)
    → health check — already running? done
    → findBackendBinary() — PATH, ~/.openclaw/bin/
    → ensureBackendBinary() — clone status-go + build (ensureGo if needed)
    → startBackendProcess() + waitForHealthy()
  → initialize → login → startMessenger
  → merge config communityIds + communities.json (persistent store)
  → joinCommunityIfNeeded() for each — deduplicated
  → listen for signals
```

### Community join flow (runtime)
```
Agent receives "join community 0x04..." (from any channel)
  → status_community tool (action: "join", communityId: "0x04...")
  → parseCommunityId() — hex ID or Status invite link
  → addCommunityId() → persists to ~/.openclaw/data/openclaw-status/communities.json
  → if gateway active: joinCommunity() RPC → status-backend → Waku
  → messages from that community start arriving via signals
```

## Plugin Structure

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest, channels declaration, configSchema |
| `src/index.ts` | Plugin entry — `register(api)`, channel + tool registration |
| `src/channel.ts` | `statusPlugin` — gateway (with auto-provisioning), outbound, config adapters |
| `src/config.ts` | Account types, `resolveStatusAccount()`, `listStatusAccountIds()` |
| `src/community-store.ts` | Persistent JSON store for dynamically joined communities |
| `src/runtime.ts` | `getStatusRuntime()` / `setStatusRuntime()` |
| `src/setup.ts` | Backend provisioning — find/build/start status-backend, Go installation |
| `src/status-client.ts` | TypeScript port of `status_client.py` — HTTP + WS client |
| `skills/status/SKILL.md` | Agent playbook |
| `test/config.test.ts` | Config resolution unit tests |
| `test/channel.test.ts` | Channel plugin contract + parseCommunityId tests |
| `test/community-store.test.ts` | Community store persistence tests |
| `test/setup.test.ts` | Backend provisioning tests |

## Channel Adapters (v0.1)

| Adapter | Status | Description |
|---------|--------|-------------|
| `config` | ✅ | listAccountIds, resolveAccount, isConfigured, describeAccount |
| `gateway` | ✅ | startAccount — auto-provision backend, connect, login, auto-join communities, listen |
| `outbound` | ✅ | sendText — send messages to community channels |
| `security` | — | v0.2: channel policies |
| `status` | — | v0.2: health checks |
| `groups` | — | v0.3: community/channel management |
| `messaging` | — | v0.3: target parsing |
| `directory` | — | v0.3: member/channel listing |
| `threading` | — | v0.4: reply threads |
| `actions` | — | v0.4: reactions, edit, delete |

## Tools

| Tool | Description |
|------|-------------|
| `status_community` | Manage communities at runtime — join (by hex ID or invite link), leave, list. Joined communities are persisted to `communities.json` in dataDir and merged with config `communityIds` on gateway start. |

## Installation

```bash
npm install && npm run build
openclaw plugins install --link .
openclaw config set plugins.entries.openclaw-status.config.password "your-password"
```

## Config (`plugins.entries.openclaw-status.config`)

Config is read from `plugins.entries.openclaw-status.config` (primary) with fallback to `channels.status` (backward compatibility).

```json
{
  "plugins": {
    "entries": {
      "openclaw-status": {
        "enabled": true,
        "config": {
          "backendUrl": "http://127.0.0.1:12345",
          "password": "your-password",
          "displayName": "OpenClaw"
        }
      }
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `backendUrl` | `http://127.0.0.1:12345` | status-backend URL |
| `backendBinary` | — | Path to status-backend executable (auto-detected if not set) |
| `keyUID` | — | Account key UID for re-login |
| `password` | — | **Required.** Account password |
| `dataDir` | `~/.openclaw/data/openclaw-status` | Data directory |
| `displayName` | `OpenClaw` | Display name (first account creation only) |
| `communityIds` | `[]` | Community ID(s) to auto-join — hex (`0x...`) or invite link. String or array. |

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

- **v0.1 (current):** Channel plugin — gateway + outbound + config + auto-provisioning
- **v0.2:** Zod validation, health checks
- **v0.3:** Community/channel management, allowlist, directory
- **v0.4:** Rich messaging (threads, reactions, media)
- **v0.5:** DM support, pairing, typing indicators
- **v1.0:** Production ready, marketplace
