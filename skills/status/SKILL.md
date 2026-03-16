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

## When to use

- "What's happening in my Status community?"
- "Send a message to the general channel in Status"
- "Check the latest messages in Status"
- "What communities am I in?"

## When NOT to use

- Regular chat or messaging unrelated to Status App
- Status.im website or Status wallet operations
- Waku protocol configuration (use status-backend directly)

## Setup requirements

1. `status-backend` binary must be running on the configured port (default: `http://127.0.0.1:12345`)
2. Channel configured with `password` in OpenClaw settings under `channels.status`
3. On first run, a new Status account is created automatically

## Configuration

In `openclaw.json`:

```json
{
  "channels": {
    "status": {
      "backendUrl": "http://127.0.0.1:12345",
      "password": "your-password",
      "displayName": "OpenClaw"
    }
  }
}
```

## Notes

- `chatId` format: typically `<communityId>-<channelName>`
- Status-backend startup takes ~10 minutes on first launch (Waku peer discovery). Be patient.
- Messages are end-to-end encrypted via the Waku protocol
