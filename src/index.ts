/**
 * OpenClaw Status Plugin — entry point.
 *
 * Registers agent tools for interacting with Status communities:
 *   - status_send_message   — send a message to a Status community channel
 *   - status_get_messages   — fetch recent messages from a channel
 *   - status_get_communities — list joined communities
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";

const plugin = {
  id: "openclaw-status",
  name: "Status Communities",
  description: "Send and receive messages in Status communities via Waku protocol",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg = api.config as {
      backendUrl?: string;
      keyUID?: string;
      password: string;
      dataDir?: string;
      displayName?: string;
    };

    const backendUrl = cfg.backendUrl ?? "http://127.0.0.1:12345";

    // Lazy-import to avoid loading at module parse time
    const getClient = async () => {
      const { StatusClient } = await import("./status-client.js");
      return new StatusClient({ baseUrl: backendUrl });
    };

    // Tool: list joined communities
    api.registerTool({
      name: "status_get_communities",
      label: "Status: Get Communities",
      description: "List all Status communities the bot has joined",
      parameters: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, _params: Record<string, unknown>) => {
        const client = await getClient();
        const communities = await client.joinedCommunities();
        return JSON.stringify(communities, null, 2);
      },
    } as Parameters<typeof api.registerTool>[0]);

    // Tool: get recent messages from a channel
    api.registerTool({
      name: "status_get_messages",
      label: "Status: Get Messages",
      description: "Fetch recent messages from a Status community channel",
      parameters: {
        type: "object" as const,
        properties: {
          chatId: {
            type: "string",
            description: "The chat/channel ID to fetch messages from",
          },
          limit: {
            type: "number",
            description: "Number of messages to fetch (default: 20)",
          },
        },
        required: ["chatId"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const client = await getClient();
        const chatId = params["chatId"] as string;
        const limit = (params["limit"] as number | undefined) ?? 20;
        const result = await client.chatMessages(chatId, "", limit);
        return JSON.stringify(result.result ?? result, null, 2);
      },
    } as Parameters<typeof api.registerTool>[0]);

    // Tool: send a message to a channel
    api.registerTool({
      name: "status_send_message",
      label: "Status: Send Message",
      description: "Send a text message to a Status community channel",
      parameters: {
        type: "object" as const,
        properties: {
          chatId: {
            type: "string",
            description: "The chat/channel ID to send the message to",
          },
          text: {
            type: "string",
            description: "The message text to send",
          },
        },
        required: ["chatId", "text"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const client = await getClient();
        const chatId = params["chatId"] as string;
        const text = params["text"] as string;
        const result = await client.sendChatMessage(chatId, text);
        return JSON.stringify(result, null, 2);
      },
    } as Parameters<typeof api.registerTool>[0]);
  },
};

export default plugin;
