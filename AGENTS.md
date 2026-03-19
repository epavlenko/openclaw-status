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

## Testing Checklist

**After any code change, run `npm run test:smoke` before considering it done.** This is the single gate between "code written" and "actually works".

### What `test:smoke` does
1. `tsc` build — catches type errors
2. `vitest run` — 67 unit tests (mocked, fast)
3. Restart `openclaw-gateway` — verify service comes back up
4. Wait for `status-backend` health check
5. E2E tests via `openclaw agent` — real tool calls through the full stack
6. Post-E2E verification — gateway still alive? Backend healthy? Log errors?

### When to run which test

| Changed file | Run |
|---|---|
| `src/channel.ts` (gateway/join logic) | `npm run test:smoke` — race conditions only show up in E2E |
| `src/community-tool.ts` | `npm test` usually enough, `test:smoke` if touching join/leave flow |
| `src/status-client.ts` (RPC calls) | `npm run test:smoke` — RPC issues only show up against real backend |
| `src/setup.ts` (provisioning) | `npm test` + manually verify `systemctl --user restart openclaw-gateway` |
| `src/config.ts`, `src/community-store.ts` | `npm test` is enough |
| `test/*` | `npm run test:smoke` to verify tests themselves work |

### Known failure patterns

These are real bugs that burned us before. Check for them after changes:

1. **RPC not ready after startMessenger** — `joinCommunity` called before `wakuext` handlers registered. Symptoms: "does not exist" error, empty response. Guard: `waitForNodeReady()` + 10s delay + retry.

2. **LoginAccount on running node** — calling `LoginAccount` when already logged in crashes status-backend. Guard: check `settings_getSettings` first.

3. **startMessenger blocks all RPC** — it's a blocking call. Must be fire-and-forget (`void client.startMessenger()`), otherwise gateway hangs.

4. **Gateway crash loop on restart** — if `startAccount()` throws synchronously, systemd restart loop hits rapidly. Guard: async errors must be caught.

5. **Multibase keys not decoded** — `status.app` URLs contain base58btc community keys. Must be decoded to hex before any RPC call or store operation. Test with both hex and link inputs.

6. **Port 61777 flakiness in unit tests** — `setup.test.ts` assumes port 61777 is free. E2E runs can spawn stray `status-backend` processes. Smoke test cleans these up.

### Manual checks (when smoke test isn't enough)

- **First launch**: Delete `~/.openclaw/data/openclaw-status/`, restart gateway, watch for ~10 min `startMessenger` completion
- **Community join**: Join a real community, verify messages appear in agent conversation
- **Cross-machine**: Waku P2P between two nodes on same machine may not deliver — test on separate hosts

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
