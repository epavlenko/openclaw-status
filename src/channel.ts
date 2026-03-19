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

// ---------------------------------------------------------------------------
// Multibase / community key decoding
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58btc string to hex (without the `z` multibase prefix). */
function base58ToHex(b58: string): string {
  let num = BigInt(0);
  for (const c of b58) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  // Preserve leading zeros
  for (const c of b58) {
    if (c !== "1") break;
    hex = "00" + hex;
  }
  return hex;
}

/**
 * Decode a multibase community key (zQ3...) to a compressed public key hex.
 *
 * Format: z (base58btc) + varint multicodec (e7 01 = secp256k1-pub) + 33-byte compressed pubkey.
 * Returns the compressed pubkey as `0x03...` (33 bytes).
 */
export function decodeMultibaseCommunityKey(key: string): string {
  if (key.startsWith("0x")) return key;
  if (!key.startsWith("z")) return key; // Not multibase, return as-is

  const hex = base58ToHex(key.slice(1)); // strip 'z' prefix
  // Skip varint multicodec prefix (e7 01 for secp256k1-pub = 2 bytes)
  // The remaining 33 bytes are the compressed public key
  if (hex.startsWith("e701") && hex.length >= 4 + 66) {
    return "0x" + hex.slice(4);
  }
  // Fallback: return full decoded hex
  return "0x" + hex;
}

/**
 * Parse a community identifier — accepts raw hex ID, multibase key, or Status invite link.
 *
 * Returns a hex community ID (0x...) suitable for status-backend RPC.
 */
export function parseCommunityId(input: string): string {
  const trimmed = input.trim();

  // Raw hex ID
  if (trimmed.startsWith("0x")) return trimmed;

  // Status invite link — extract community key from fragment
  let key = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hash) {
      const extracted = url.hash.replace(/^#\/?/, "");
      if (extracted.length > 0) key = extracted;
    }
  } catch {
    // Not a URL — use as-is
  }

  // Decode multibase key (zQ3...) to hex
  return decodeMultibaseCommunityKey(key);
}

/** Wait until status-backend RPC handlers are fully ready. */
async function waitForNodeReady(
  client: StatusClient,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // joinedCommunities is a good canary — it uses wakuext namespace
      // which is only available after messenger is fully initialized
      await client.joinedCommunities();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

async function joinCommunityIfNeeded(
  client: StatusClient,
  rawCommunityId: string,
): Promise<void> {
  const communityId = parseCommunityId(rawCommunityId);
  const short = communityId.slice(0, 16);

  // Check if already joined
  const joined = await client.joinedCommunities();
  const alreadyJoined = joined.some((c) => c.id === communityId);

  if (alreadyJoined) {
    console.log(`[status] Already a member of community ${short}...`);
    return;
  }

  // Fetch community description from Waku network first
  console.log(`[status] Fetching community ${short}...`);
  try {
    await client.fetchCommunity(communityId);
  } catch (err) {
    console.warn(`[status] fetchCommunity failed (may still work): ${err}`);
  }

  // Try direct join first (open communities), fallback to request (closed).
  // Retry if RPC methods not registered yet after startMessenger.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[status] Joining community ${short}... (attempt ${attempt})`);
    try {
      const result = await client.joinCommunity(communityId);
      if (result.error) {
        const msg = result.error.message ?? "";
        if (msg.includes("does not exist") && attempt < maxAttempts) {
          console.log(`[status] RPC not ready, retrying in 5s...`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        // joinCommunity failed — try requestToJoinCommunity (for closed communities)
        console.log(`[status] Direct join failed (${msg}), trying request to join...`);
        const reqResult = await client.requestToJoinCommunity(communityId);
        if (reqResult.error) {
          console.error(`[status] Join request also failed: ${reqResult.error.message}`);
        } else {
          console.log(`[status] Join request sent for community ${short}`);
        }
      } else {
        console.log(`[status] Joined community ${short}`);
      }
    } catch (err) {
      if (attempt < maxAttempts) {
        console.log(`[status] Join error, retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
    break;
  }
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

      // Initialize and login (skip if already logged in on a running node)
      try {
        // Check if already logged in — LoginAccount on running node causes crash
        let alreadyLoggedIn = false;
        try {
          const settings = await client.getSettings();
          if (settings && Object.keys(settings).length > 0) {
            alreadyLoggedIn = true;
            console.log(`[status] Backend already logged in, skipping initialize/login`);
          }
        } catch {
          // Not logged in or backend not initialized — proceed with login
        }

        if (!alreadyLoggedIn) {
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

        // Auto-join communities after node is ready.
        // Wait for node.ready signal before attempting joins — RPC handlers crash
        // if called too early after startMessenger.
        void (async () => {
          // Wait for node.ready (up to 60s)
          console.log(`[status] Waiting for node.ready before joining communities...`);
          const ready = await waitForNodeReady(client, 60_000);
          if (!ready) {
            console.warn(`[status] node.ready timeout, attempting joins anyway`);
          }

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
