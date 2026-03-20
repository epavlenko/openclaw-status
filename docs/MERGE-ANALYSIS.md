# Merge Analysis: openclaw-status Repositories

**Date:** 2026-03-20
**Status:** Draft — for discussion

> **Disclosure:** This document was written by the author of Repo A. It aims to be objective, but inherent bias is possible. Repo B's team is invited to review, challenge, and amend any part of this analysis.

## Background

Václav Pavlín proposed consolidating two independent Status plugin implementations into "one canonical OpenClaw plugin for Status integration that works really well." Both repos were built in parallel with different priorities: Repo B (jimmy-claw) focused on DM messaging, wallet integration, and operational tooling on ARM64 hardware; Repo A (epavlenko) focused on community management, SDK-compliant inbound pipeline, and auto-provisioning — porting patterns from the earlier `status-app-agent` Python bot. Notably, community support (which Repo B struggled with) is working in Repo A.

This document provides a technical comparison to help decide how to merge.

| | **Repo A** (`epavlenko/openclaw-status`) | **Repo B** (`jimmy-claw/status-openclaw-plugin`) |
|---|---|---|
| Commits | 28 | ~30 (125 total incl. reverts/fixups) |
| Source lines | ~2,900 (src + tests + scripts) | ~2,500 (src + wallet + commands) |
| Tests | 67 unit (vitest) + e2e + smoke | 0 |
| Plugin ID | `openclaw-status` | `status` |

---

## 1. Architecture Comparison

### 1.1 Inbound Message Pipeline

This is the most significant architectural difference between the two projects.

**Repo A** uses the OpenClaw SDK dispatch flow, modeled after the IRC plugin pattern:

```
WebSocket signal (messages.new)
  → resolveAgentRoute()
  → resolveStorePath()
  → formatAgentEnvelope()
  → finalizeInboundContext()
  → recordInboundSession()
  → dispatchReplyWithBufferedBlockDispatcher()
    → deliver() → sendChatMessage()
```

This gives the host framework full control over routing, session management, envelope formatting, and reply dispatch. The plugin participates in the standard channel lifecycle.

**Repo B** uses a system event workaround:

```
WebSocket signal / poll
  → construct "[Status DM from ...]" text string
  → enqueueSystemEvent() or `openclaw system event --mode now` CLI
```

This approach was practical for getting a working bot quickly, but has trade-offs:
- DM policies (`pairing`, `allowlist`) are defined in the config schema but not enforced at the inbound gate
- No programmatic sender attribution — the agent sees a text prefix, not structured metadata
- No reply routing back to the specific Status sender or group
- No session management — the framework cannot track conversation history per peer

Repo B's own code review (`REVIEW.md`) identifies this as a priority item for improvement.

### 1.2 Gateway Lifecycle

**Repo A** manages the full backend lifecycle inside `startAccount()`:

1. `ensureBackend()` — find binary on PATH / `~/.openclaw/bin/` / download prebuilt from GitHub Release
2. `StatusClient.initialize()` — with `logEnabled: true`
3. Login strategy cascade: check if already logged in → config keyUID → saved keyUID → first existing account → create new account
4. Wait for `node.login` WebSocket signal (not just HTTP response — `LoginAccount` is async)
5. Fire-and-forget `startMessenger()` (blocks ~10 min on first launch)
6. Wait for RPC readiness (`isRpcReady()` polls `wakuext_joinedCommunities`)
7. Auto-join communities: merge config `communityIds` + persistent `communities.json`
8. Community join sequence: `fetchCommunity` → `spectateCommunity` → `requestToJoinCommunity`
9. Spectate all joined communities (required after every restart for Waku topic subscription)
10. Hold promise alive (`await ctx.abortSignal`) — gateway expects long-lived `startAccount()`

**Repo B** takes a different approach, delegating lifecycle management to systemd:

1. Health check — expect `status-backend` to be already running (via `status-backend.service`)
2. Wait up to 60s for `getActiveChats` to return (login handled by `status-login.service`)
3. Fetch public key from `settings_getSettings`
4. Seed `seenMessages` set from recent chat history
5. Start WebSocket signal listener + polling interval
6. Return `{ stop }` cleanup handle

This systemd-based approach reflects real production experience on ARM64 hardware, where process management through systemd provides auto-restart on SIGSEGV crashes and proper service ordering. The trade-off is that the plugin cannot self-provision — first-time setup requires manual systemd configuration.

### 1.3 Community Management

**Repo A** has a complete community management system:

- `community-store.ts` — persistent JSON store for dynamically joined communities
- `community-tool.ts` — agent tool with join/leave/list actions
- `parseCommunityId()` — accepts hex IDs, multibase-encoded keys (`zQ3...`), and `status.app` invite URLs
- `decodeMultibaseCommunityKey()` — base58btc → secp256k1 pubkey hex conversion
- `joinCommunityIfNeeded()` — idempotent join with fetch → spectate → requestToJoin sequence
- Skill definition (`SKILL.md`) for agent discovery

**Repo B** was designed for 1:1 DMs, with group chat support added later via polling. Community join/leave is not exposed to the agent.

### 1.4 Status Backend Client

**Repo A** uses an OOP `StatusClient` class (~300 lines) with:
- `StatusBackendError` for structured error handling (distinguishes HTTP API string errors from JSON-RPC object errors)
- HTTP response validation (`!r.ok` → throw)
- Community methods: `fetchCommunity`, `spectateCommunity`, `requestToJoinCommunity`, `joinedCommunities`, `getAccounts`
- Contact methods: `acceptContactRequest`, `acceptAllPendingContactRequests`, `acceptCommunityInvitations`
- RPC readiness check: `isRpcReady()`

**Repo B** uses standalone functions in separate modules:
- `src/status-api.ts` — REST + RPC wrapper (~120 lines)
- `src/status-signals.ts` — WebSocket connection with exponential backoff reconnect (~90 lines)
- `src/wallet/rpc.ts` — independent RPC client with double-JSON parsing

The wallet module has its own `callRPC` function that reads `STATUS_BACKEND_URL` from an environment variable, while the main `status-api.ts` takes a port parameter. Two independent RPC clients for the same backend.

### 1.5 Production Hardening

**Repo A:**
- `LoginAccount` on running node detection — check `settings_getSettings` for `public-key` before login (avoids crash)
- `LoginAccount` is async — wait for `node.login` signal, check `error` field
- `startMessenger` fire-and-forget — avoids gateway hang
- `startAccount` keep-alive — await `ctx.abortSignal` to prevent health monitor restart loop
- `keyUID` persistence — `account.json` in dataDir with 3-strategy fallback
- `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` for `libsds.so` next to binary
- Backend log capture to `status-backend.log` (not `/dev/null`)
- `waitForNodeReady()` — polls `isRpcReady()` before community joins

**Repo B:**
- `seenMessages` dedup — Set-based message ID tracking
- Per-chat `lastSeenTimestamp` — avoids replaying old messages
- Exponential backoff WebSocket reconnect (1s → 30s cap)
- Group chat info caching for DM/group resolution
- Dual-mode inbound (WS + polling) — resilient to WebSocket instability on ARM64
- systemd auto-restart on SIGSEGV crashes with full re-login sequence
- `requestAllHistoricMessages` after crash recovery to fetch missed Waku messages

### 1.6 Modularity and Separation of Concerns

**Repo A** keeps the entire gateway lifecycle, inbound dispatch, community join logic, and outbound adapter in a single 652-line `channel.ts`. This is an effective approach for rapid iteration but means that testing, reading, or replacing individual concerns (e.g., inbound handler vs. login flow) requires working inside a large file. Config, community store, and the tool are properly split into separate modules.

**Repo B** separates the HTTP API client (`status-api.ts`), WebSocket signals (`status-signals.ts`), and wallet RPC (`wallet/rpc.ts`) into distinct modules. The command system (`commands/*`) is cleanly separated from the channel adapter. However, the separation introduces the dual-RPC-client issue mentioned in 1.4.

### 1.7 Dependency Surface

**Repo A:** Zero runtime dependencies. Uses only Node.js built-ins (`fetch`, `WebSocket`, `fs`, `child_process`). Dev dependencies: `typescript`, `vitest`, `@types/node`.

**Repo B:** Runtime dependencies: `ws` (WebSocket library), `zod` (schema validation). Peer dependency: `openclaw`. Dev dependencies: `typescript`, `@types/ws`. The `ws` dependency is notable — Repo A achieves the same functionality using the native `WebSocket` global (available in Node.js 22+), avoiding the extra dependency.

### 1.8 Testing

**Repo A:**
- Unit tests (vitest): config resolution, channel contract, community store, community tool, setup provisioning, `parseCommunityId` — 67 tests total
- E2E tests (`test/e2e-tool.sh`): real tool calls through `openclaw agent` against live backend
- Smoke test (`test/smoke.sh`): build → unit tests → gateway restart → backend health → e2e → post-e2e verification
- Documented testing checklist in AGENTS.md with known failure patterns

**Repo B:** No automated test files. Validation has been through manual testing and weeks of production use on ARM64.

---

## 2. Feature Comparison

### 2.1 Features Only in Repo A

| Feature | Files | Lines |
|---------|-------|-------|
| SDK inbound pipeline (routing, session, envelope, dispatch) | `channel.ts:229–317` | ~90 |
| Auto-provisioning (find/download/start backend) | `setup.ts` | 230 |
| Login lifecycle (3-strategy, signal-based) | `channel.ts:468–558` | ~90 |
| Community management (join/leave/list tool) | `community-tool.ts`, `community-store.ts` | 175 |
| Multibase community key decoding | `channel.ts:61–126` | 66 |
| RPC readiness check | `status-client.ts:274–282` | 9 |
| keyUID persistence (account.json) | `channel.ts:37–51` | 15 |
| Agent skill (SKILL.md) | `skills/status/SKILL.md` | 59 |
| 67 unit + e2e + smoke tests | `test/*` | ~600 |
| | | **~1,334** |

### 2.2 Features Only in Repo B

| Feature | Files | Lines |
|---------|-------|-------|
| Wallet module (balances, tokens, send, ENS) | `src/wallet/*` | ~450 |
| Command router (!balance, !tip, !signers, etc.) | `src/commands/*` | ~400 |
| Governance module (multi-sig-lite proposals) | `src/commands/governance.ts` | ~200 |
| Wallet address registry | `src/commands/registry.ts` | ~100 |
| Zod config schema validation | `src/config-schema.ts` | 35 |
| DM support with policies (pairing, allowlist, open) | `channel.ts`, `config-schema.ts` | ~60 |
| Polling fallback (WS + 15s poll dual-mode) | `channel.ts` | ~80 |
| WebSocket signals with exponential backoff | `status-signals.ts` | 90 |
| Operational scripts (login, ctl, watch, install) | `extras/scripts/` | ~400 |
| systemd service units (backend, login, daemon) | `extras/systemd/` | ~60 |
| KNOWN-ISSUES.md (ARM64, WebSocket, RPC providers) | `docs/KNOWN-ISSUES.md` | 150 |
| WALLET-INTEGRATION.md (research & plan) | `docs/WALLET-INTEGRATION.md` | ~300 |
| BUILD.md (ARM64 from-source guide) | `BUILD.md` | ~200 |
| bot.sh (command watcher) | `bot.sh` | ~50 |
| | | **~2,575** |

### 2.3 Features in Both (Different Implementations)

| Feature | Repo A | Repo B |
|---------|--------|--------|
| Plugin registration | `register(api)` with channel + tool | `register(api)` with channel only |
| Config resolution | Manual TypeScript with dual-path lookup | Zod schema with `buildChannelConfigSchema` |
| Outbound messaging | `sendChatMessage` (community group) | `sendOneToOneMessage` (DM) |
| WebSocket signals | Simple auto-reconnect (2s) | Exponential backoff (1s → 30s) |
| Runtime store | `any` typed (no SDK compile dep) | `PluginRuntime` typed (SDK import) |

---

## 3. Known Functional Issues

### 3.1 Repo A

- **No polling fallback** — relies solely on WebSocket signals. If WebSocket is unstable (documented on ARM64 in Repo B's KNOWN-ISSUES.md), messages can be missed.
- **No DM support** — only `chatTypes: ["group"]`. The v0.5 roadmap item.
- **No Zod validation** — config parsing is manual TypeScript without runtime schema validation.
- **WebSocket reconnect is naive** — fixed 2s delay, no exponential backoff.
- **No seenMessages dedup** — if WebSocket reconnects and replays recent signals, duplicates could be processed.

### 3.2 Repo B

- **Inbound pipeline bypasses SDK** — `enqueueSystemEvent()` workaround. Acknowledged in `REVIEW.md` as a priority item.
- **No auto-provisioning** — requires systemd setup (by design — see 1.2).
- **No login lifecycle in plugin** — delegated to `status-login.service`.
- **No automated tests** — validated through manual testing.
- **Two independent RPC clients** — `status-api.ts` and `wallet/rpc.ts` maintain separate connections.
- **Unbounded `seenMessages` Set** — grows indefinitely, no eviction.
- **`chatInfoCache` never cleared** — memory growth on long-running instances.
- **Zod schema ordering** — `z.number().default(21405).optional()` — `.default()` before `.optional()` has ambiguous behavior in Zod v4.
- **No community management** — no join/leave/list, no invite link parsing.
- **Wallet module not wired into channel plugin** — exists as standalone module, not integrated into message dispatch.

---

## 4. Security Audit

A detailed security audit of both repositories is available in [SECURITY-AUDIT.md](SECURITY-AUDIT.md). Summary below.

| Aspect | Repo A | Repo B |
|--------|--------|--------|
| Critical findings | 0 | 2 (unauthorized tip transactions, broken governance execution) |
| High findings | 4 | 8 |
| Medium findings | 5 | 6 |
| Financial safety | No wallet code | No authorization on `!tip`, no rate limit, float precision bugs |
| Inbound trust boundary | No sender allowlist, but dispatches through SDK | No sender check, routes to hardcoded Telegram session |
| Config injection | SSRF via `baseUrl`, path traversal via `dataDir` | SSRF via `port`, JSON injection in shell scripts |
| Resource exhaustion | WebSocket no backoff | Unbounded Set + Map growth |

Both repos share the same pattern of plaintext passwords in config with no keychain integration.

---

## 5. Merge Options

*Hour estimates below are approximate and intended for relative comparison of effort between options, not as delivery commitments.*

### Option A: Merge Into Repo A

Repo B's wallet, DM, polling, Zod, and operational assets are contributed as PRs into `epavlenko/openclaw-status`.

**Pros:**
- SDK inbound pipeline preserved — no architectural rework needed
- 67 existing tests provide a safety net for integration
- Wallet and DM features are additive modules that integrate cleanly
- Auto-provisioning and login lifecycle are preserved
- Community management is preserved

**Cons:**
- Repo B features need adaptation to Repo A's patterns (e.g., wallet RPC must use `StatusClient`)
- Jimmy loses primary ownership of his repository
- Repo B's operational knowledge (ARM64 quirks, crash recovery) must be carefully preserved

**Estimated work:**

| Item | Effort | Priority |
|------|--------|----------|
| Polling fallback (dual WS+poll) | 2–3 hours | High |
| Zod config schema | 1–2 hours | Medium |
| WebSocket exponential backoff | 1 hour | Medium |
| DM support (chatTypes, dmPolicy, allowFrom) | 4–6 hours | Medium |
| Port wallet module (unify on StatusClient) | 4–6 hours | Medium |
| Port command router (adapt to SDK dispatch) | 4–6 hours | Low |
| Port governance module | 2–3 hours | Low |
| Copy operational scripts (extras/) | 1 hour | Low |
| Copy operational docs | 1 hour | Low |
| **Total** | **~20–34 hours** | |

### Option B: Merge Into Repo B

The core from Repo A (SDK pipeline, auto-provisioning, login lifecycle, community management, tests) is ported into `jimmy-claw/status-openclaw-plugin`.

**Pros:**
- Repo B already has wallet, commands, DM support, and operational scripts in place
- Proven in production on ARM64 for weeks — known issues are documented and mitigated
- Jimmy retains primary ownership and continuity

**Cons:**
- Requires replacing the inbound pipeline — affects `channel.ts` (the largest file)
- Requires adding auto-provisioning, login lifecycle, community management, and tests
- Net result is a significant rework of Repo B's core, preserving wallet and command modules
- No existing tests to catch regressions during the rework

**Estimated work:**

| Item | Effort | Priority |
|------|--------|----------|
| Replace inbound pipeline with SDK dispatch | 6–8 hours | Critical |
| Add auto-provisioning (setup.ts) | 3–4 hours | High |
| Add login lifecycle + signal handling | 4–6 hours | High |
| Add community management + tool | 4–6 hours | High |
| Add keyUID persistence | 1–2 hours | High |
| Port tests (adapt to Repo B patterns) | 6–8 hours | High |
| Unify dual RPC clients | 2–3 hours | Medium |
| Fix critical security issues (auth, governance) | 3–4 hours | Critical |
| Fix high security issues (SSRF, rate limiting, etc.) | 4–6 hours | High |
| Fix ethToWeiHex precision | 1 hour | Low |
| Fix Zod schema ordering | 30 min | Low |
| **Total** | **~35–50 hours** | |

### Option C: New Shared Repository

Create a new repository (e.g., `openclaw-community/status`) and cherry-pick from both.

**Pros:**
- Neutral ground — neither contributor "loses" their repo
- Opportunity to redesign the file layout from scratch
- Both contributors start as equal co-owners

**Cons:**
- Git history from both repos is lost (or requires complex merge)
- All integration work still needs to happen — same total effort as Option A or B
- Additional overhead: new CI, new npm package name, new plugin ID

### Option D: Monorepo / Workspace

One repo hosts both as workspace packages (e.g., `packages/core` from Repo A, `packages/wallet` from Repo B) with a shared `status-client`.

**Pros:**
- Clean separation of concerns
- Each contributor maintains their area

**Cons:**
- Overengineered for a plugin of this size (~3,000 lines total)
- OpenClaw plugin system expects a single entry point, not a monorepo
- Adds build complexity (workspace tooling, shared types)

---

## 6. Discussion: Choosing a Base

The analysis above is meant to inform a joint decision. Here are the key factors to weigh.

### Arguments for Repo A as Base

1. **SDK compliance.** Repo A's inbound pipeline uses the standard SDK dispatch flow. Adding it to Repo B would require replacing core message handling. Moving in the other direction (adding Repo B's features to Repo A) is additive.

2. **Community support works.** The community join flow (fetch → spectate → requestToJoin) is implemented and tested in Repo A. This was identified as a blocking issue for Repo B.

3. **Test coverage.** Merging features into a tested codebase is safer than merging an entire architecture into an untested one.

4. **Asymmetric portability.** Repo B's unique assets (wallet, commands, DM, Zod, polling, scripts, docs) are self-contained modules that port cleanly. Repo A's unique assets (SDK pipeline, auto-provisioning, login lifecycle, community management) are deeply woven into the gateway and harder to extract.

### Arguments for Repo B as Base

1. **Battle-tested on real hardware.** Repo B has been running in production on ARM64 (Raspberry Pi 5) for weeks — handling real DMs, real wallet transactions on Sepolia, real SIGSEGV crashes and recoveries. This operational knowledge is captured in KNOWN-ISSUES.md, BUILD.md, and the systemd service architecture. It is hard to replicate without running on the same hardware.

2. **More user-facing features.** Wallet integration with working balance/tip/governance commands, DM policies, wallet address registry — these represent significant functionality that users interact with directly.

3. **Contributor continuity.** Jimmy has been actively iterating on this plugin in a real community setting. The commit history reflects real-world debugging (WebSocket instability, IPv6 issues, poll-based fallback, Waku peer discovery) that only comes from production use.

4. **Richer operational tooling.** systemd services, login scripts, control scripts, build guides — production deployment infrastructure that Repo A lacks entirely.

### Arguments for a New Shared Repo

1. **Neutral ground.** No contributor "loses" their repo. Both start as equal co-owners.

2. **Clean start.** Opportunity to agree on naming, structure, and ownership together.

3. **Same total effort.** The integration work is the same regardless of which existing repo is chosen — a new repo just removes the "whose repo" question.

### Attribution

Regardless of which repo is chosen as base, all contributions should be properly attributed via `Co-Authored-By` headers or a `CONTRIBUTORS.md` file. Both repos contain significant original work.

---

## Appendix A: File Inventory

### Repo A — `epavlenko/openclaw-status`

```
src/
  index.ts              — plugin entry, registers channel + tool
  channel.ts            — gateway, outbound, config, inbound dispatch (652 lines)
  config.ts             — account types, resolution, defaults (129 lines)
  status-client.ts      — HTTP + WS client class (304 lines)
  setup.ts              — auto-provisioning: find/download/start (230 lines)
  community-store.ts    — persistent community JSON store (63 lines)
  community-tool.ts     — agent tool: join/leave/list (114 lines)
  runtime.ts            — plugin runtime store (23 lines)
  types/openclaw.d.ts   — SDK type stubs
test/
  channel.test.ts       — channel contract + parseCommunityId tests
  config.test.ts        — config resolution tests
  community-store.test.ts
  community-tool.test.ts
  setup.test.ts         — provisioning tests
  e2e-tool.sh           — end-to-end via openclaw agent
  smoke.sh              — full pipeline: build → test → gateway → e2e
skills/status/SKILL.md  — agent skill definition
docs/status-backend-api.md — internal API reference
```

### Repo B — `jimmy-claw/status-openclaw-plugin`

```
index.ts                — plugin entry
src/
  channel.ts            — gateway, outbound, config, system event dispatch (~300 lines)
  config-schema.ts      — Zod config schema (35 lines)
  runtime.ts            — plugin runtime store (15 lines)
  status-api.ts         — standalone HTTP + RPC functions (~120 lines)
  status-signals.ts     — WebSocket with exponential backoff (~90 lines)
  types.ts              — TypeScript types
  commands/
    index.ts            — command router
    balance.ts          — !balance command
    tip.ts              — !tip command
    governance.ts       — multi-sig proposals
    registry.ts         — wallet address registry
  wallet/
    index.ts            — barrel exports
    types.ts            — wallet API types
    rpc.ts              — independent RPC client
    balances.ts         — balance queries
    tokens.ts           — token lookup + cache
    send.ts             — build→sign→send flow
extras/
  scripts/              — install.sh, status-ctl.sh, status-login.sh, status-watch.sh
  skill/SKILL.md        — skill docs
  systemd/              — service units
docs/
  KNOWN-ISSUES.md       — ARM64 crashes, WS instability, RPC providers
  WALLET-INTEGRATION.md — wallet research & implementation plan
  LIVESTREAM-SCRIPT.md  — demo script
bot.sh                  — command watcher
BUILD.md                — ARM64 build guide
REVIEW.md               — self-review
```
