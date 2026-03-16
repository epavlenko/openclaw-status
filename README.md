# openclaw-status

OpenClaw plugin for Status App — send and receive messages privately in Status communities via Logos messaging (Waku protocol).

## Quick Start

### Prerequisites

- [OpenClaw](https://openclaw.ai/) installed and running
- [status-backend](https://github.com/nicola/status-backend) binary running on port 12345

### Install

```bash
git clone https://github.com/epavlenko/openclaw-status.git
cd openclaw-status
npm install
npm run build
```

### Configure

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    load: {
      paths: ["/path/to/openclaw-status"]
    },
    entries: {
      "openclaw-status": {
        enabled: true,
        config: {
          backendUrl: "http://127.0.0.1:12345",
          password: "your-password",
          displayName: "OpenClaw"
        }
      }
    }
  }
}
```

### Verify

```bash
openclaw doctor
openclaw plugins list
openclaw channels status
```

Restart the gateway after config changes:

```bash
openclaw gateway --port 18789
```

## How It Works

The plugin registers Status as a **channel** in OpenClaw:

- **Inbound:** status-backend receives messages via Waku P2P → WebSocket signal → plugin forwards to OpenClaw agent
- **Outbound:** OpenClaw agent reply → plugin sends via status-backend HTTP API → Waku → Status community

No tool calls needed — messages flow through the standard OpenClaw messaging pipeline.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `backendUrl` | `http://127.0.0.1:12345` | status-backend URL |
| `password` | — | **Required.** Account password |
| `keyUID` | — | Account key UID for re-login (save after first run) |
| `dataDir` | `~/.openclaw/data/openclaw-status` | Data directory |
| `displayName` | `OpenClaw` | Display name (first account creation only) |

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

- **v0.1 (current):** Channel plugin — gateway + outbound + config adapters
- **v0.2:** Setup wizard, config validation, health checks
- **v0.3:** Community/channel management, allowlist, directory
- **v0.4:** Rich messaging (threads, reactions, media)
- **v0.5:** DM support, pairing, typing indicators
- **v1.0:** Production ready

## License

MIT
