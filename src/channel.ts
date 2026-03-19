/**
 * Status channel plugin — ChannelPlugin<ResolvedStatusAccount> implementation.
 *
 * Follows the Nostr plugin pattern: gateway (startAccount/stopAccount),
 * outbound (sendText), and config adapter.
 */

import { StatusClient } from "./status-client.js";
import {
  listStatusAccountIds,
  resolveStatusAccount,
  resolveDefaultStatusAccountId,
  type ResolvedStatusAccount,
} from "./config.js";
import { getStatusRuntime } from "./runtime.js";
import { ensureBackend } from "./setup.js";
import { loadCommunityStore } from "./community-store.js";

// ---------------------------------------------------------------------------
// Community join helper
// ---------------------------------------------------------------------------

/**
 * Parse a community identifier — accepts raw hex ID or a Status invite link.
 *
 * Status invite links have the format:
 *   https://status.app/c/<base64url-encoded-data>#<community-key>
 *   https://status.app/c#/<community-key>
 *
 * The community key after `#` (or `#/`) is used as the community ID.
 * If the input starts with `0x`, it is treated as a raw hex community ID.
 */
export function parseCommunityId(input: string): string {
  const trimmed = input.trim();

  // Raw hex ID
  if (trimmed.startsWith("0x")) return trimmed;

  // Status invite link — extract community key from fragment
  try {
    const url = new URL(trimmed);
    if (url.hash) {
      const key = url.hash.replace(/^#\/?/, "");
      if (key.length > 0) return key;
    }
  } catch {
    // Not a URL — use as-is
  }

  return trimmed;
}

async function joinCommunityIfNeeded(
  client: StatusClient,
  rawCommunityId: string,
): Promise<void> {
  const communityId = parseCommunityId(rawCommunityId);

  // Check if already joined
  const joined = await client.joinedCommunities();
  const alreadyJoined = joined.some((c) => c.id === communityId);

  if (alreadyJoined) {
    console.log(`[status] Already a member of community ${communityId.slice(0, 16)}...`);
    return;
  }

  console.log(`[status] Requesting to join community ${communityId.slice(0, 16)}...`);
  await client.joinCommunity(communityId);
  console.log(`[status] Join request sent for community ${communityId.slice(0, 16)}...`);
}

// ---------------------------------------------------------------------------
// Active client registry (one per account, like Nostr's activeBuses)
// ---------------------------------------------------------------------------

interface ActiveAccount {
  client: StatusClient;
  abortController: AbortController;
}

const activeClients = new Map<string, ActiveAccount>();

export function getActiveClient(accountId = "default"): ActiveAccount | undefined {
  return activeClients.get(accountId);
}

// ---------------------------------------------------------------------------
// Channel plugin definition
// ---------------------------------------------------------------------------

// We use structural typing — no import of ChannelPlugin from SDK.
// OpenClaw validates the shape at registration time.

export const statusPlugin = {
  id: "status" as const,

  meta: {
    id: "status",
    label: "Status",
    selectionLabel: "Status App",
    docsPath: "/channels/status",
    blurb:
      "Send and receive messages privately in Status communities via Logos messaging (Waku protocol).",
  },

  capabilities: {
    chatTypes: ["group"] as const,
    media: false,
  },

  reload: { configPrefixes: ["plugins.entries.openclaw-status.config", "channels.status"] },

  // ---------------------------------------------------------------------------
  // Config adapter
  // ---------------------------------------------------------------------------

  config: {
    listAccountIds: (cfg: Record<string, unknown>) =>
      listStatusAccountIds(cfg),

    resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) =>
      resolveStatusAccount(cfg, accountId),

    defaultAccountId: (cfg: Record<string, unknown>) =>
      resolveDefaultStatusAccountId(cfg),

    isConfigured: (account: ResolvedStatusAccount) => account.configured,

    isEnabled: (account: ResolvedStatusAccount) => account.enabled,

    describeAccount: (account: ResolvedStatusAccount) => ({
      accountId: account.accountId,
      name: account.displayName,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.backendUrl,
    }),
  },

  // ---------------------------------------------------------------------------
  // Gateway adapter — connects to status-backend and listens for messages
  // ---------------------------------------------------------------------------

  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: ResolvedStatusAccount;
      abortSignal: AbortSignal;
      setStatus: (next: Record<string, unknown>) => void;
    }) => {
      const { accountId, account, setStatus } = ctx;
      const runtime = getStatusRuntime();
      const abortController = new AbortController();

      // Ensure status-backend is running (auto-provision if needed)
      setStatus({ provisioning: true });
      const backendResult = await ensureBackend(
        account.backendUrl,
        account.backendBinary,
      );
      if (!backendResult.ok) {
        const msg = backendResult.error ?? "Failed to provision status-backend";
        setStatus({ connected: false, running: false, lastError: msg, provisioning: false });
        throw new Error(`[status] Backend provisioning failed: ${msg}`);
      }
      if (backendResult.started) {
        console.log(`[status] Auto-started status-backend (${backendResult.binaryPath})`);
      }
      setStatus({ provisioning: false });

      const client = new StatusClient({ baseUrl: account.backendUrl });

      // Initialize and login
      try {
        await client.initialize(account.dataDir);

        if (account.keyUID) {
          await client.login(account.keyUID, account.password);
        } else {
          await client.createAccount(
            account.displayName,
            account.password,
            account.dataDir,
          );
        }

        // startMessenger blocks for ~10 min on first launch (Waku peer discovery).
        // Fire-and-forget — don't await. All subsequent RPC calls queue behind it
        // and execute once messenger is ready.
        console.log(`[status] Starting messenger (may take ~10 min on first launch)...`);
        void client.startMessenger().then(
          () => console.log(`[status] Messenger started`),
          (err) => console.error(`[status] startMessenger error:`, err),
        );

        setStatus({ connected: true, running: true, lastConnectedAt: Date.now() });
        console.log(`[status] Account ${accountId} connected (messenger starting in background)`);

        // Auto-join communities from config + persistent store.
        // These RPC calls queue behind startMessenger and execute when ready.
        void (async () => {
          const stored = await loadCommunityStore(account.dataDir);
          const allCommunityIds = [
            ...new Set([...account.communityIds, ...stored.communityIds]),
          ];
          for (const cid of allCommunityIds) {
            try {
              await joinCommunityIfNeeded(client, cid);
            } catch (err) {
              console.error(`[status] Failed to join community ${cid}:`, err);
            }
          }
        })();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus({ connected: false, running: false, lastError: msg });
        console.error(`[status] Account ${accountId} failed to start:`, msg);
        throw err;
      }

      // Listen for incoming messages via WebSocket signals
      void client.listenSignals(async (type, event) => {
        if (type !== "messages.new") return;

        const messages = (event?.["messages"] as Array<{
          id: string;
          chatId: string;
          text: string;
          from: string;
          timestamp: number;
          contentType: number;
        }>) ?? [];

        for (const msg of messages) {
          // Skip non-text messages
          if (msg.contentType !== 1) continue;
          // Skip own messages (from this account)
          // We can't easily check this without knowing our own pubkey,
          // but status-backend typically doesn't echo own messages in signals.

          try {
            await runtime.channel?.reply?.handleInboundMessage?.({
              channel: "status",
              accountId,
              senderId: msg.from,
              chatType: "group",
              chatId: msg.chatId,
              text: msg.text,
              messageId: msg.id,
              timestamp: msg.timestamp,
            });
          } catch (err) {
            console.error("[status] Failed to handle inbound message:", err);
          }
        }

        setStatus({ lastInboundAt: Date.now() });
      });

      activeClients.set(accountId, { client, abortController });

      return {
        stop: () => {
          abortController.abort();
          activeClients.delete(accountId);
          setStatus({ connected: false, running: false, lastStopAt: Date.now() });
          console.log(`[status] Account ${accountId} stopped`);
        },
      };
    },
  },

  // ---------------------------------------------------------------------------
  // Outbound adapter — sends messages to Status community channels
  // ---------------------------------------------------------------------------

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    sendText: async (ctx: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string | null;
    }) => {
      const accountId = ctx.accountId ?? "default";
      const active = activeClients.get(accountId);

      if (!active) {
        throw new Error(
          `[status] No active client for account "${accountId}". Is the gateway running?`,
        );
      }

      await active.client.sendChatMessage(ctx.to, ctx.text);

      return {
        channel: "status" as const,
        messageId: `status-${Date.now()}`,
        chatId: ctx.to,
      };
    },
  },
};
