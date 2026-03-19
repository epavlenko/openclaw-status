# status-backend API Reference

Internal reference for openclaw-status plugin development.

Sources:
- [status-im/status-go](https://github.com/status-im/status-go) (GitHub + local clone at `~/.openclaw/src/status-go/`)
- [status-backend README](https://github.com/status-im/status-go/blob/develop/cmd/status-backend/README.md)
- Python reference bot (`status-app-agent/src/bot.py`, `status_client.py`)
- Runtime testing against status-backend on this machine

## Architecture

```
openclaw-status (TypeScript)
  → HTTP POST  →  status-backend (Go binary, port 12345)
  ← WebSocket  ←  /signals (real-time events)
                      ↓
                   status-go library
                      ↓ Waku P2P
                   Status Network
```

status-backend is a thin HTTP wrapper around the full status-go library.
All business logic (communities, messaging, crypto) lives in status-go.

---

## HTTP Endpoints

### `GET /health`
Health check. Returns `{"version": "..."}` with HTTP 200 if operational.

### `POST /statusgo/InitializeApplication`
Initialize the application. Must be called before login/create.

**Request:**
```json
{"dataDir": "/path/to/data"}
```

**Response:**
```json
{
  "accounts": [
    {"key-uid": "0xabc...", "name": "OpenClaw", "identicon": "..."}
  ]
}
```

- `accounts`: list of existing accounts in the data directory
- Empty `accounts` array = fresh installation, need to create account

### `POST /statusgo/CreateAccountAndLogin`
Create a new account and login. Generates BIP39 mnemonic internally.

**Request:**
```json
{
  "rootDataDir": "/path/to/data",
  "displayName": "OpenClaw",
  "password": "...",
  "customizationColor": "primary"
}
```

**Response:** `{"error": ""}` on success. The `keyUID` is NOT in the HTTP response —
it comes from the `node.login` signal event data OR must be read from `settings_getSettings` after login.

**Signal:** Fires `node.login` signal asynchronously.

### `POST /statusgo/LoginAccount`
Login to an existing account using keyUID.

**Request:**
```json
{"keyUID": "0xabc...", "password": "..."}
```

**Response:** `{"error": ""}` — but this is **misleading**. The HTTP response returns
immediately with no error even when login fails. The actual result comes asynchronously
via the `node.login` WebSocket signal.

**Critical:** Do NOT trust the HTTP response. Always wait for `node.login` signal
and check its `error` field.

**Gotcha:** Calling LoginAccount when already logged in returns `{"error": "node is already running"}`
or crashes the backend. Always check `settings_getSettings` for `public-key` first.

### `POST /statusgo/CallRPC`
JSON-RPC gateway to all status-go services.

**Request:**
```json
{"jsonrpc": "2.0", "id": 1, "method": "wakuext_methodName", "params": [...]}
```

**Response:**
```json
{"jsonrpc": "2.0", "id": 1, "result": ..., "error": {"code": -32000, "message": "..."}}
```

- `error` is an **object** `{code, message}` (JSON-RPC standard), NOT a string
- HTTP API errors (`InitializeApplication`, `LoginAccount`) use **string** errors
- `id` field is **required** — omitting causes empty/broken responses

---

## WebSocket Signals

### `ws://host:port/signals`

**Gotcha:** status-backend does NOT respond to WebSocket pings. Disable keepalive.

### Signal format
```json
{"type": "signal.name", "event": {...}}
```

### Key signals

| Signal | When | Event fields |
|--------|------|-------------|
| `node.login` | After LoginAccount/CreateAccountAndLogin completes | `error` (string), `settings`, `account` |
| `node.started` | Node process started | — |
| `node.ready` | Node fully initialized | — |
| `messages.new` | New messages received | `messages[]` — array of message objects |
| `mediaserver.started` | Media server ready | — |
| `mailserver.changed` | Connected to mailserver | — |
| `mailserver.available` | Mailserver available | — |
| `history.request.started` | Fetching message history | — |
| `history.request.completed` | History fetch done | — |
| `envelope.sent` | Message envelope sent via Waku | — |

### `node.login` signal details
```json
{
  "type": "node.login",
  "event": {
    "error": "",          // empty = success, non-empty = failure reason
    "settings": {...},
    "account": {...}
  }
}
```

Special cases:
- `"error": "node is already running"` — treat as success
- `"error": "failed to get account kdf iterations..."` — keyUID doesn't exist in data dir

---

## RPC Methods

### `settings_getSettings`
Get account settings.

**Params:** `[]`

**Result:** Object with settings fields:
```json
{
  "public-key": "0x04abc...",
  "display-name": "OpenClaw",
  "key-uid": "0xabc...",
  ...
}
```

**Usage:** Check `result["public-key"]` to determine if backend is logged in.

### `wakuext_startMessenger`
Start the Waku messenger service. Must be called after login.

**Params:** `[]`

**Behavior:**
- Blocks for 1s–10min on first launch (Waku peer discovery)
- All other `wakuext_*` calls queue behind it
- Subsequent calls return immediately ("already started")
- On failure, may return `"method handler crashed"` error

### `wakuext_joinedCommunities`
List communities the user has joined.

**Params:** `[]`

**Result:** Array of Community objects:
```json
[{
  "id": "0x03abc...",
  "name": "Community Name",
  "joined": true,           // user called Join — LOCAL flag
  "isMember": true,         // user's pubkey in community Members map — NETWORK flag
  "verified": true,
  "canPost": null,           // null = not computed at community level
  "members": {
    "0x04pubkey...": {"roles": [1]}
  },
  "chats": {
    "chat-uuid": {
      "name": "general",
      "canPost": true        // whether THIS user can post in THIS channel
    }
  }
}]
```

#### CRITICAL: `joined` vs `isMember`

| Field | Meaning | Set by |
|-------|---------|--------|
| `joined` | "I want to be in this community" | Local `JoinCommunity()` call |
| `isMember` | "My pubkey is in the community's Members map" | Community control node (owner) |

**`joined: true` + `isMember: false`** = The bot asked to join locally, but the community
owner's node hasn't added the bot to the members list (or the updated community description
hasn't been received via Waku yet).

**Root cause of "can't post" errors:** `canPost` on a channel requires `isMember: true`.

### `wakuext_joinCommunity`
**LOCAL-ONLY join.** Sets `joined: true` but does NOT send a join request to the community control node.

**Params:** `["0xcommunityId"]`

**What it does:**
1. Sets `joined = true` in local DB
2. Initializes community chats and filters
3. Does NOT contact the community owner
4. Does NOT add user to Members map

**When to use:** NEVER for joining an external community. Use `requestToJoinCommunity` instead.
This method is useful for re-joining a community you were already a member of (e.g., after data restore).

### `wakuext_requestToJoinCommunity`
**NETWORK join request.** Sends a join request to the community's control node via Waku.

**Params:**
```json
[{
  "communityId": "0x03abc...",
  "addressesToReveal": ["0xWalletAddress"],
  "airdropAddress": "0xWalletAddress"
}]
```

**What it does:**
1. Validates request parameters
2. Checks if already a member (returns error if so)
3. Processes `addressesToReveal` — validates against token permissions
4. Creates `CommunityRequestToJoin` protobuf message
5. **Sends request to control node via Waku pubsub**
6. For open communities: control node auto-accepts
7. For closed communities: control node queues for manual approval
8. Creates activity center notification

**When to use:** ALWAYS for joining a community you're not already a member of.

**addressesToReveal:** Required. At minimum, pass one wallet address from `accounts_getAccounts`.
Even for open communities (no token gates), the protocol expects addresses to be revealed.

### `wakuext_fetchCommunity`
Fetch community description from the Waku network.

**Params:**
```json
[{
  "communityKey": "0x03abc...",
  "tryDatabase": true,
  "waitForResponse": true
}]
```

**Result:** Community object (description, name, members, chats, etc.)

**When to use:** Before joining — ensures the local node has the community description.
Without this, `requestToJoinCommunity` may fail with "community not found".

### `wakuext_sendChatMessage`
Send a text message to a chat.

**Params:**
```json
[{
  "chatId": "communityId + chatUUID",
  "text": "Hello!",
  "contentType": 1
}]
```

**Chat ID format:** `{communityId}{chatUUID}` — concatenation without separator.
Example: `0x03abc...8a805944-9f5d-4219-a104-5d2047f5572a`

**Error `"can't post message type '1' on chat '...'"` means:**
- `canPost: false` on the channel
- Usually because `isMember: false` (see `joined` vs `isMember` above)

### `wakuext_chatMessages`
Read message history for a chat.

**Params:** `[chatId, cursor, limit]`
- `chatId`: string (communityId + chatUUID)
- `cursor`: string (empty for first page)
- `limit`: number

### `wakuext_leaveCommunity`
Leave a community.

**Params:** `["0xcommunityId"]`

### `wakuext_communities`
List ALL communities (joined + known but not joined).

**Params:** `[]`

### `accounts_getAccounts`
List accounts (wallet addresses).

**Params:** `[]`

**Result:**
```json
[
  {"address": "0xabc...", "wallet": true, "chat": false, "type": "generated"},
  {"address": "0xdef...", "wallet": false, "chat": true, "type": "key"}
]
```

**Usage:** Find the wallet address (`wallet: true`) for `addressesToReveal` in `requestToJoinCommunity`.

---

## Correct Startup Sequence

```
1. WebSocket connect to /signals
2. POST /statusgo/InitializeApplication → get existing accounts
3. Login or CreateAccount:
   a. If keyUID known → POST /statusgo/LoginAccount
   b. If accounts exist → LoginAccount with first account's key-uid
   c. Otherwise → POST /statusgo/CreateAccountAndLogin
4. Wait for node.login signal (check error field!)
5. CallRPC wakuext_startMessenger (fire-and-forget, don't await)
6. Wait for RPC readiness (poll wakuext_joinedCommunities until no "does not exist" error)
7. Now other RPC calls work
```

## Correct Community Join Sequence

```
1. Get wallet address: accounts_getAccounts → find wallet: true
2. Fetch community description: wakuext_fetchCommunity
3. Spectate community: wakuext_spectateCommunity (subscribes to Waku topics!)
4. Request to join: wakuext_requestToJoinCommunity with addressesToReveal
5. Wait for community owner to accept (open communities: auto-accept)
6. isMember becomes true → wakuext_sendChatMessage works
```

**Critical:** Step 3 (spectate) is required. Without it, the join request is sent
but never delivered to the community control node because the bot isn't subscribed
to the community's Waku pubsub topics. 1:1 messages work without spectating,
but community operations do not.

**Common mistake #1:** Skipping `spectateCommunity` before `requestToJoinCommunity`.
**Common mistake #2:** Using `wakuext_joinCommunity` instead of `requestToJoinCommunity`.
`joinCommunity` is LOCAL-ONLY and will never result in `isMember: true`.

---

## Error Reference

| Error | Meaning | Fix |
|-------|---------|-----|
| `"does not exist"` | RPC handler not registered yet | Wait for startMessenger to complete |
| `"node is already running"` | LoginAccount called on running node | Check settings_getSettings first |
| `"can't post message type '1'"` | isMember is false, canPost is false | Use requestToJoinCommunity, wait for membership |
| `"community already joined"` | joinCommunity called when already joined | Skip or use requestToJoinCommunity |
| `"community not found"` | Community description not fetched | Call fetchCommunity first |
| `"method handler crashed"` | RPC handler internal error | Retry after delay, check messenger is started |
| `"failed to get account kdf iterations"` | keyUID doesn't exist in data dir | Use different keyUID or create new account |
| `"ErrPermissionToJoinNotSatisfied"` | Wallet doesn't meet token requirements | Check token gate requirements |

---

## Python Reference Bot Pattern

The working Python bot (`status-app-agent`) uses `requestToJoinCommunity` for ALL joins:

```python
# status_client.py — CORRECT: always uses requestToJoinCommunity
async def join_community(self, community_id):
    return await self.call_rpc("wakuext_requestToJoinCommunity",
        [{"communityId": community_id}])

# For communities found via activity center — passes wallet address
async def accept_community_invitations(self):
    # ...
    await self.call_rpc("wakuext_requestToJoinCommunity", [{
        "communityId": cid,
        "addressesToReveal": [wallet_addr],
        "airdropAddress": wallet_addr,
    }])
```

The bot does NOT create communities — it only joins existing ones.
The bot accepts community invitations via `wakuext_acceptActivityCenterNotifications` (type 6).

---

## RequestToJoinCommunity Go Signature

From `~/.openclaw/src/status-go/protocol/requests/request_to_join_community.go`:

```go
type RequestToJoinCommunity struct {
    CommunityID          types.HexBytes   `json:"communityId"`
    ENSName              string           `json:"ensName"`
    AddressesToReveal    []string         `json:"addressesToReveal"`
    Signatures           []types.HexBytes `json:"signatures"`
    AirdropAddress       string           `json:"airdropAddress"`
    ShareFutureAddresses bool             `json:"shareFutureAddresses"`
}
```

For open communities without token gates, `addressesToReveal` and `airdropAddress`
are optional but recommended — the protocol expects them.

---

## Debugging: status-backend Logging

**Current state:** status-backend is spawned with `stdio: "ignore"` in `setup.ts`.
No Go-side logs are captured anywhere.

**To enable logging**, modify `setup.ts` spawn:
```typescript
const logFile = openSync(join(dataDir, 'status-backend.log'), 'a');
const child = spawn(abs, ["--address", `127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env,
});
```

Or pass `logLevel` and `logEnabled` in `InitializeApplication`:
```json
{"dataDir": "...", "logEnabled": true, "logLevel": "DEBUG"}
```

---

## Key Source Files (status-go)

| File | What |
|------|------|
| `protocol/messenger_communities.go` | JoinCommunity, RequestToJoinCommunity, FetchCommunity implementations |
| `protocol/communities/community.go` | Community struct, isMember(), canPost(), MarshalJSON |
| `protocol/communities/manager.go` | Community manager, membership management |
| `protocol/requests/request_to_join_community.go` | RequestToJoinCommunity request struct |
| `services/ext/api.go` | RPC method registration (wakuext_* → Go functions) |
| `mobile/status.go` | HTTP endpoints (InitializeApplication, LoginAccount, etc) |
| `cmd/status-backend/` | status-backend binary entry point |

Local clone: `~/.openclaw/src/status-go/`
GitHub: https://github.com/status-im/status-go
