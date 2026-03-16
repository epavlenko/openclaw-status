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

// ---------------------------------------------------------------------------
// Active client registry (one per account, like Nostr's activeBuses)
// ---------------------------------------------------------------------------

interface ActiveAccount {
  client: StatusClient;
  abortController: AbortController;
}

const activeClients = new Map<string, ActiveAccount>();

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

  reload: { configPrefixes: ["channels.status"] },

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
      const client = new StatusClient({ baseUrl: account.backendUrl });
      const abortController = new AbortController();

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

        await client.startMessenger();

        setStatus({ connected: true, running: true, lastConnectedAt: Date.now() });
        console.log(`[status] Account ${accountId} connected`);
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
