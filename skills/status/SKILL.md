---
name: status
description: Interact with Status App communities — send messages, read chat history, list communities
metadata:
  {
    "openclaw": {
      "emoji": "🔵",
      "requires": {
        "config": ["plugins.openclaw-status"]
      }
    }
  }
---

# Status Communities Skill

Use this skill when the user asks to interact with Status App communities: reading messages, sending messages, checking community membership, or managing community activity.

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
2. Plugin configured with `password` and optionally `keyUID` in OpenClaw settings
3. On first run, a new Status account is created automatically

## Available tools

### `status_get_communities`
List all Status communities the bot has joined.

```json
{
  "tool": "status_get_communities",
  "params": {}
}
```

### `status_get_messages`
Fetch recent messages from a community channel.

```json
{
  "tool": "status_get_messages",
  "params": {
    "chatId": "<community-id>-<channel-name>",
    "limit": 20
  }
}
```

### `status_send_message`
Send a text message to a community channel.

```json
{
  "tool": "status_send_message",
  "params": {
    "chatId": "<community-id>-<channel-name>",
    "text": "Hello from OpenClaw!"
  }
}
```

## Notes

- `chatId` format: typically `<communityId>-<channelName>` — use `status_get_communities` first to discover available chat IDs
- Status-backend startup takes ~10 minutes on first launch (Waku peer discovery). Be patient.
- Messages are end-to-end encrypted via the Waku protocol
