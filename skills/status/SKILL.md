---
name: status
description: "Join, leave, and interact with Status App communities and channels. Handles status.app links (status.app/c/, status.app/cc/), community hex IDs (0x...), and community management."
metadata:
  {
    "openclaw": {
      "emoji": "🔵",
      "requires": {
        "config": ["plugins.entries.openclaw-status.config"]
      }
    }
  }
---

# Status Communities Skill

Use this skill when the user asks anything about Status App communities — joining, leaving, listing, or messaging.

**IMPORTANT:** When the user asks to join a community or shares a `status.app` link, use the `status_community` tool. Do NOT open a browser or use Chrome. This is a backend operation.

## Community management — use the `status_community` tool

**Join a community** (by hex ID, `status.app/c/...`, or `status.app/cc/...` link):
```
status_community(action: "join", communityId: "<hex ID or full URL>")
```

**List communities:**
```
status_community(action: "list")
```

**Leave a community:**
```
status_community(action: "leave", communityId: "<hex ID or full URL>")
```

Pass the full URL or hex ID as-is — the plugin parses it automatically.

## Messaging

Incoming messages from joined Status communities arrive automatically via the channel plugin — no tool calls needed. Outbound replies are sent through the standard OpenClaw messaging pipeline.

## When to use

- User shares a `status.app/c/...` or `status.app/cc/...` link
- "Join this Status community: 0x04abc..."
- "Join this community: https://status.app/c#zQ3..."
- "What communities am I in?"
- "Leave community X"
- "What's happening in my Status community?"
- "Send a message to the general channel in Status"

## When NOT to use

- Regular chat or messaging unrelated to Status App
- Status.im website or Status wallet operations
- Waku protocol configuration (use status-backend directly)
