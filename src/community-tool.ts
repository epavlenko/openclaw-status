/**
 * status_community tool — manage Status communities at runtime.
 *
 * Extracted from index.ts for testability (no openclaw/plugin-sdk dependency).
 */

import { getActiveClient, parseCommunityId } from "./channel.js";
import { resolveStatusAccount } from "./config.js";
import { addCommunityId, removeCommunityId, loadCommunityStore } from "./community-store.js";

export function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function parseToolResult(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

export { parseToolResult };

export function buildCommunityTool(config: Record<string, unknown>) {
  return {
    name: "status_community",
    description:
      "Manage Status communities. Actions: " +
      "join (join a community by ID or invite link), " +
      "leave (remove a community from auto-join list), " +
      "list (list joined and configured communities).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["join", "leave", "list"],
          description: "The action to perform",
        },
        communityId: {
          type: "string",
          description:
            "Community ID (hex 0x...) or Status invite link (https://status.app/c/...). Required for join/leave.",
        },
      },
      required: ["action"],
    },

    async execute(_id: string, params: Record<string, unknown>) {
      const action = params.action as string;
      const account = resolveStatusAccount(config);
      const active = getActiveClient(account.accountId);

      if (action === "list") {
        const stored = await loadCommunityStore(account.dataDir);
        const configIds = account.communityIds;
        const joinedRemote = active
          ? await active.client.joinedCommunities()
          : [];

        return toolResult({
          configCommunityIds: configIds,
          savedCommunityIds: stored.communityIds,
          joinedCommunities: joinedRemote.map((c) => ({
            id: c.id,
            name: c.name,
            joined: c.joined,
          })),
        });
      }

      const rawId = params.communityId as string | undefined;
      if (!rawId) {
        throw new Error("communityId is required for join/leave");
      }
      const communityId = parseCommunityId(rawId);

      if (action === "join") {
        const added = await addCommunityId(account.dataDir, communityId);

        if (active) {
          const joined = await active.client.joinedCommunities();
          const alreadyJoined = joined.some((c) => c.id === communityId);
          if (!alreadyJoined) {
            await active.client.joinCommunity(communityId);
          }
          return toolResult({
            communityId,
            persisted: added,
            joinRequestSent: !alreadyJoined,
            alreadyJoined,
          });
        }

        return toolResult({
          communityId,
          persisted: added,
          joinRequestSent: false,
          note: "Gateway not running. Community will be joined on next gateway start.",
        });
      }

      if (action === "leave") {
        const removed = await removeCommunityId(account.dataDir, communityId);
        return toolResult({
          communityId,
          removed,
          note: removed
            ? "Removed from saved communities. Note: still a member until you leave via Status app."
            : "Community ID not found in saved list.",
        });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
