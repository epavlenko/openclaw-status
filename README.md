# openclaw-status

OpenClaw plugin for Status App — send and receive messages privately in Status communities via Logos messaging (Waku protocol).

## Quick Start

### Prerequisites

- [OpenClaw](https://openclaw.ai/) installed and running

### Install & Configure

```bash
git clone https://github.com/epavlenko/openclaw-status.git
cd openclaw-status
npm install && npm run build

# Install the plugin
openclaw plugins install --link .

# Set password (required)
openclaw config set plugins.entries.openclaw-status.config.password "your-password"
```

Optional settings:

```bash
# Display name (default: "OpenClaw")
openclaw config set plugins.entries.openclaw-status.config.displayName "MyBot"

# Auto-join a community (hex ID or invite link)
openclaw config set plugins.entries.openclaw-status.config.communityIds "0x04abc..."

# Auto-join multiple communities
openclaw config set plugins.entries.openclaw-status.config.communityIds '["0x04abc...", "0x04def..."]'

# Backend URL (default: http://127.0.0.1:12345)
openclaw config set plugins.entries.openclaw-status.config.backendUrl "http://127.0.0.1:12345"

# Backend binary path (auto-detected if not set)
openclaw config set plugins.entries.openclaw-status.config.backendBinary "/path/to/status-backend"

# Key UID for re-login with existing account
openclaw config set plugins.entries.openclaw-status.config.keyUID "0x..."
```

### Verify

```bash
openclaw plugins list
openclaw channels list
```

Then restart the gateway:

```bash
openclaw gateway --port 18789
```

## How It Works

The plugin registers Status as a **channel** in OpenClaw:

- **Inbound:** status-backend receives messages via Waku P2P → WebSocket signal → plugin forwards to OpenClaw agent
- **Outbound:** OpenClaw agent reply → plugin sends via status-backend HTTP API → Waku → Status community

Messages flow through the standard OpenClaw messaging pipeline — no tool calls needed for send/receive.

### Community Management

The plugin provides a `status_community` tool that the agent can call at runtime (e.g. when asked via Telegram):

- **join** — join a community by hex ID or invite link, persisted across restarts
- **leave** — remove a community from the auto-join list
- **list** — show configured, saved, and joined communities

Dynamically joined communities are stored in `communities.json` inside the data directory and merged with config `communityIds` on every gateway start.

### Auto-provisioning

When the gateway starts, the plugin automatically ensures status-backend is running:

1. Health check at the configured URL
2. Search for the binary on PATH and `~/.openclaw/bin/`
3. If not found — download Go from go.dev, clone status-go, build from source
4. Start the binary and wait for healthy

No manual binary management required.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `backendUrl` | `http://127.0.0.1:12345` | status-backend URL |
| `backendBinary` | — | Path to status-backend executable (auto-detected if not set) |
| `password` | — | **Required.** Account password |
| `keyUID` | — | Account key UID for re-login (save after first run) |
| `dataDir` | `~/.openclaw/data/openclaw-status` | Data directory |
| `displayName` | `OpenClaw` | Display name (first account creation only) |
| `communityIds` | `[]` | Community ID(s) to auto-join — hex or invite link. String or array. |

## Development

```bash
npm run dev           # watch mode
npm run test          # run tests
npm run lint          # type-check
```

## Known Gotchas

- **First launch takes ~10 minutes** — Waku peer discovery via `startMessenger`. Be patient.
- **status-backend doesn't respond to WS pings** — keepalive is disabled in the client.
- **Save `keyUID` after first run** — avoids creating a new account on every restart.
- **Config changes require gateway restart** — file watch does not reload plugin config.

## Roadmap

- **v0.1 (current):** Channel plugin — gateway + outbound + config + auto-provisioning
- **v0.2:** Config validation (Zod), health checks
- **v0.3:** Community/channel management, allowlist, directory
- **v0.4:** Rich messaging (threads, reactions, media)
- **v0.5:** DM support, pairing, typing indicators
- **v1.0:** Production ready

## License

MIT
