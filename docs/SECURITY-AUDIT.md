# Security Audit: openclaw-status Repositories

**Date:** 2026-03-20
**Scope:** `epavlenko/openclaw-status` (Repo A) and `jimmy-claw/status-openclaw-plugin` (Repo B)

> **Disclosure:** This audit was conducted by the author of Repo A. Findings should be independently verified.

Both repositories were audited for credential exposure, injection vulnerabilities, authorization gaps, resource exhaustion, and financial safety (wallet operations). The trust boundary model: config/filesystem = trusted; status-backend on localhost = semi-trusted; Waku network (any peer) = untrusted.

---

## 1. Repo A — `epavlenko/openclaw-status`

| Severity | Issue | Location |
|----------|-------|----------|
| High | Binary downloaded from GitHub Release with no checksum/signature verification — supply-chain risk | `src/setup.ts:67–100` |
| High | SSRF via `baseUrl` config — no host/scheme restriction, any URL accepted | `src/status-client.ts:56` |
| High | Unsanitized Waku message content passed as `CommandBody` to agent — prompt/command injection surface | `src/channel.ts:270` |
| High | Path traversal via `dataDir` — `community-store.ts` and `channel.ts` join user-controlled paths with no containment check | `src/community-store.ts:15–24` |
| Medium | `status_community` tool callable by any agent session — unauthenticated inbound Waku message can trigger community joins via agent | `src/community-tool.ts:46` |
| Medium | No sender authentication on inbound messages — any community member triggers agent dispatch | `src/channel.ts:447–463` |
| Medium | `LD_LIBRARY_PATH` injection via `binaryPath` config — operator-controlled directory prepended to library search path | `src/setup.ts:136–141` |
| Medium | No response size limit on HTTP/WebSocket — OOM via large backend response | `src/status-client.ts` |
| Medium | TOCTOU race in `addCommunityId` — concurrent calls can produce duplicates | `src/community-store.ts:47–61` |
| Medium | Password stored and transmitted as plaintext over localhost HTTP | `src/config.ts:114` |
| Low | Shell injection pattern in `execSync` — currently safe (hardcoded values) but fragile if values become configurable | `src/setup.ts:79–83` |
| Low | WebSocket reconnects indefinitely with no backoff or circuit breaker | `src/status-client.ts:256–259` |
| Low | Backend error text propagated verbatim in exceptions | `src/status-client.ts:292–299` |

**Totals: 0 critical, 4 high, 5 medium, 3 low**

---

## 2. Repo B — `jimmy-claw/status-openclaw-plugin`

Note: the hardcoded wallet address and password (`"jimmy-claw-2026"`) in `tip.ts` and `send.ts` are Sepolia testnet values used for development/demo purposes, not production credentials. They are flagged below as a pattern issue (hardcoded fallbacks should not ship to production), not as a credential leak.

| Severity | Issue | Location |
|----------|-------|----------|
| **Critical** | Zero authorization on `!tip` — any Status user can trigger ETH transactions. No sender check, no rate limit. Wallet drainable in 0.01 ETH increments | `src/commands/tip.ts` |
| **Critical** | Governance execution flow broken — after approval, the message instructs the user to re-send `!tip`, but that re-enters `checkGovernance()` and creates a *new* proposal instead of executing the approved one. Approved proposals may never execute through the normal flow. The `executeProposal()` function itself is safe (checks `status === "approved"` with sync file I/O), but no code path calls it after approval | `src/commands/governance.ts` |
| High | Hardcoded admin pubkey with no rotation mechanism — if admin account is compromised, governance cannot be recovered | `src/commands/governance.ts` |
| High | Hardcoded Telegram session key (`agent:main:telegram:direct:78701493`) — all inbound Status messages routed to a single Telegram session regardless of sender | `src/channel.ts` |
| High | Unbounded `seenMessages` Set — grows indefinitely, OOM via message flood from any peer | `src/channel.ts` |
| High | `STATUS_BACKEND_URL` env var accepted without validation — SSRF redirect if env is compromised | `src/wallet/rpc.ts` |
| High | `port` config param enables local SSRF — no range validation, can hit any localhost service | `src/status-api.ts` |
| High | No rate limiting on tip flow — 0.01 ETH ceiling per-tip but unlimited tips per-sender, per-day | `src/commands/tip.ts` |
| High | `DATA_DIR` interpolated unsanitized into JSON body in shell script — JSON injection | `extras/scripts/status-login.sh` |
| High | Float precision loss in `ethToWeiHex` — `parseFloat(amount) * 1e18` loses precision beyond 2^53 | `src/wallet/send.ts` |
| High | Password stored as plaintext in config, no keychain/env-ref pattern | `src/config-schema.ts` |
| Medium | Hardcoded test wallet password as fallback default in 3 files — bad pattern for production, should require explicit config | `src/wallet/send.ts`, `src/commands/tip.ts`, `extras/scripts/status-login.sh` |
| Medium | Raw backend error text propagated to chat users — leaks internal paths, stack traces | `src/wallet/rpc.ts`, `src/status-api.ts` |
| Medium | `chatInfoCache` never cleared — memory growth vector | `src/channel.ts` |
| Medium | `Math.random()` proposal IDs — trivially guessable, and auto-resolution makes them irrelevant when only one proposal is pending | `src/commands/governance.ts` |
| Medium | Non-atomic file writes (`writeFileSync`) — crash mid-write corrupts governance state, resetting signers | `src/commands/governance.ts` |
| Medium | `displayName` from user input stored unsanitized — potential stored injection | `src/commands/registry.ts` |

**Totals: 2 critical, 8 high, 6 medium, 0 low**

---

## 3. Shared Issues

Both repos share these patterns:

- **Plaintext passwords in config** — neither repo supports keychain integration or environment variable references for the account password.
- **No sender allowlist enforcement** — Repo A dispatches all inbound messages through the SDK without checking sender identity; Repo B doesn't check against its `allowFrom` config.
- **Unauthenticated status-backend** — the localhost HTTP API has no authentication, so any local process can send RPC calls.
