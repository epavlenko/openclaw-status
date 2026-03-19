/**
 * Status channel plugin — ChannelPlugin<ResolvedStatusAccount> implementation.
 *
 * Follows the Nostr plugin pattern: gateway (startAccount/stopAccount),
 * outbound (sendText), and config adapter.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { StatusClient, StatusBackendError } from "./status-client.js";
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
// keyUID persistence helpers
// ---------------------------------------------------------------------------

function resolveDir(dataDir: string): string {
  if (dataDir.startsWith("~")) {
    return join(homedir(), dataDir.slice(1));
  }
  return dataDir;
}

interface AccountFile {
  keyUID: string;
}

async function loadSavedKeyUID(dataDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(resolveDir(dataDir), "account.json"), "utf-8");
    const data = JSON.parse(raw) as Partial<AccountFile>;
    return data.keyUID || undefined;
  } catch {
    return undefined;
  }
}

async function saveKeyUID(dataDir: string, keyUID: string): Promise<void> {
  const dir = resolveDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "account.json"), JSON.stringify({ keyUID }, null, 2) + "\n", "utf-8");
}

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
    if (await client.isRpcReady()) return true;
    await new Promise((r) => setTimeout(r, 2000));
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

      // node.login signal result — resolved with true (success) or false (error)
      let loginSignalResolve: (success: boolean) => void;
      let loginSignalPromise = new Promise<boolean>((r) => { loginSignalResolve = r; });
      const resetLoginSignal = () => {
        loginSignalPromise = new Promise<boolean>((r) => { loginSignalResolve = r; });
      };

      // Start signal listener BEFORE login (like Python bot.py:44)
      // so we catch the node.login signal
      void client.listenSignals(async (type, event) => {
        if (type === "node.login") {
          const error = (event?.["error"] as string) ?? "";
          if (error && error.includes("already running")) {
            console.log(`[status] Node already running (signal), proceeding`);
            loginSignalResolve(true);
          } else if (error) {
            console.error(`[status] Login failed (signal): ${error}`);
            loginSignalResolve(false);
          } else {
            console.log(`[status] Login successful (signal)`);
            loginSignalResolve(true);
          }
          return;
        }

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
          if (msg.contentType !== 1) continue;

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

      // Helper: attempt login and wait for signal result (30s timeout)
      const tryLogin = async (keyUID: string, label: string): Promise<boolean> => {
        resetLoginSignal();
        console.log(`[status] ${label} (${keyUID.slice(0, 20)}...)`);
        try {
          await client.login(keyUID, account.password);
        } catch (err) {
          if (err instanceof StatusBackendError && err.message.includes("already running")) {
            console.log(`[status] Node already running, treating as success`);
            return true;
          }
          console.warn(`[status] Login HTTP error: ${err instanceof Error ? err.message : err}`);
          return false;
        }
        // Wait for node.login signal to know if login actually succeeded
        const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 30_000));
        const success = await Promise.race([loginSignalPromise, timeout]);
        return success;
      };

      // Initialize and login
      try {
        // Check if already logged in — LoginAccount on running node causes crash
        let alreadyLoggedIn = false;
        try {
          const settings = await client.getSettings();
          if (settings?.["public-key"]) {
            alreadyLoggedIn = true;
            console.log(`[status] Backend already logged in, skipping initialize/login`);
          }
        } catch {
          // Not logged in or backend not initialized — proceed with login
        }

        if (!alreadyLoggedIn) {
          // Initialize and get existing accounts
          const initResult = await client.initialize(account.dataDir);
          const existingAccounts = (initResult?.["accounts"] as Array<{ "key-uid": string; name?: string }>) ?? [];

          // Determine effective keyUID: config → saved
          const savedKeyUID = await loadSavedKeyUID(account.dataDir);
          const effectiveKeyUID = account.keyUID || savedKeyUID;

          let loggedIn = false;

          // Strategy 1: login with config/saved keyUID
          if (effectiveKeyUID) {
            loggedIn = await tryLogin(effectiveKeyUID, "Logging in with keyUID");
          }

          // Strategy 2: login with first existing account from initialize()
          if (!loggedIn && existingAccounts.length > 0) {
            const first = existingAccounts[0];
            const fallbackUID = first["key-uid"];
            loggedIn = await tryLogin(fallbackUID, `Falling back to account "${first.name ?? "?"}"`);
            if (loggedIn) {
              await saveKeyUID(account.dataDir, fallbackUID);
            }
          }

          // Strategy 3: create new account
          if (!loggedIn) {
            console.log(`[status] Creating new account: ${account.displayName}`);
            resetLoginSignal();
            const createResult = await client.createAccount(
              account.displayName,
              account.password,
              account.dataDir,
            );
            const newKeyUID = (createResult?.["keyUID"] as string) ?? "";
            if (newKeyUID) {
              await saveKeyUID(account.dataDir, newKeyUID);
            }
            // Wait for node.login signal after createAccount
            const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 30_000));
            const success = await Promise.race([loginSignalPromise, timeout]);
            if (!success) {
              console.warn(`[status] Timed out waiting for node.login after createAccount`);
            }
          } else if (effectiveKeyUID && !savedKeyUID) {
            await saveKeyUID(account.dataDir, effectiveKeyUID);
          }

          // startMessenger blocks for ~10 min on first launch (Waku peer discovery).
          // Fire-and-forget — don't await.
          console.log(`[status] Starting messenger (may take ~10 min on first launch)...`);
          void client.startMessenger().then(
            () => console.log(`[status] Messenger started`),
            (err) => console.error(`[status] startMessenger error:`, err),
          );
        }

        setStatus({ connected: true, running: true, lastConnectedAt: Date.now() });
        console.log(`[status] Account ${accountId} connected`);

        // Auto-join communities after node is ready
        void (async () => {
          console.log(`[status] Waiting for node to be ready before joining communities...`);
          await new Promise((r) => setTimeout(r, 10_000));
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

      activeClients.set(accountId, { client, abortController });

      // Keep alive — gateway expects startAccount to stay pending.
      // When startAccount's promise resolves, the gateway sets running=false
      // and triggers auto-restart. We must await the abort signal.
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      // Cleanup after abort
      activeClients.delete(accountId);
      console.log(`[status] Account ${accountId} stopped`);
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
