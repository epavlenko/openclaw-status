---
name: status
description: Interact with Status App communities — messages arrive automatically via the channel plugin
metadata:
  {
    "openclaw": {
      "emoji": "🔵",
      "requires": {
        "config": ["channels.status"]
      }
    }
  }
---

# Status Communities Skill

Use this skill when the user asks to interact with Status App communities.

## How it works

Status is registered as a **channel plugin**. Incoming messages from Status communities arrive automatically — no tool calls needed. Outbound replies are sent through the standard OpenClaw messaging pipeline.

For community management, use the `status_community` tool:
- `status_community(action: "join", communityId: "0x04..." or "https://status.app/c/...")` — join a community
- `status_community(action: "list")` — list configured, saved, and joined communities
- `status_community(action: "leave", communityId: "0x04...")` — remove from auto-join list

Joined communities are persisted across restarts in `communities.json`.

## When to use

- "What's happening in my Status community?"
- "Send a message to the general channel in Status"
- "Check the latest messages in Status"
- "What communities am I in?"
- "Join this Status community: 0x04abc..."
- "Join this community: https://status.app/c#zQ3..."

## When NOT to use

- Regular chat or messaging unrelated to Status App
- Status.im website or Status wallet operations
- Waku protocol configuration (use status-backend directly)

## Setup requirements

1. Plugin installed via `openclaw plugins install --link .`
2. Password configured via `openclaw config set plugins.entries.openclaw-status.config.password "..."`
3. The gateway auto-starts status-backend if not running (builds from source if needed)
4. On first run, a new Status account is created automatically

## Configuration

Via OpenClaw CLI:

```bash
openclaw config set plugins.entries.openclaw-status.config.password "your-password"
openclaw config set plugins.entries.openclaw-status.config.displayName "OpenClaw"
```

## Notes

- `chatId` format: typically `<communityId>-<channelName>`
- Status-backend startup takes ~10 minutes on first launch (Waku peer discovery). Be patient.
- Messages are end-to-end encrypted via the Waku protocol
