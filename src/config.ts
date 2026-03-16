/**
 * Account configuration types and resolution for Status channel plugin.
 *
 * Follows the OpenClaw ChannelConfigAdapter pattern (see Nostr plugin).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusAccountConfig {
  backendUrl?: string;
  keyUID?: string;
  password?: string;
  dataDir?: string;
  displayName?: string;
  enabled?: boolean;
}

export interface ResolvedStatusAccount {
  accountId: string;
  backendUrl: string;
  keyUID: string | undefined;
  password: string;
  dataDir: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:12345";
const DEFAULT_DATA_DIR = "~/.openclaw/data/openclaw-status";
const DEFAULT_DISPLAY_NAME = "OpenClaw";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Read the `channels.status.accounts` block from OpenClaw config. */
function readAccountsBlock(
  cfg: Record<string, unknown>,
): Record<string, StatusAccountConfig> {
  const channels = (cfg as Record<string, unknown>)?.["channels"] as
    | Record<string, unknown>
    | undefined;
  const status = channels?.["status"] as Record<string, unknown> | undefined;
  const accounts = status?.["accounts"] as
    | Record<string, StatusAccountConfig>
    | undefined;

  // Support flat config (no accounts block) — treat root as single account
  if (!accounts && status) {
    return { [DEFAULT_ACCOUNT_ID]: status as unknown as StatusAccountConfig };
  }

  return accounts ?? {};
}

// ---------------------------------------------------------------------------
// Exported functions (used by ChannelConfigAdapter)
// ---------------------------------------------------------------------------

export function listStatusAccountIds(cfg: Record<string, unknown>): string[] {
  return Object.keys(readAccountsBlock(cfg));
}

export function resolveDefaultStatusAccountId(
  cfg: Record<string, unknown>,
): string {
  const ids = listStatusAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveStatusAccount(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedStatusAccount {
  const accounts = readAccountsBlock(cfg);
  const id = accountId ?? resolveDefaultStatusAccountId(cfg);
  const raw = accounts[id] ?? {};

  const password = raw.password ?? "";

  return {
    accountId: id,
    backendUrl: raw.backendUrl ?? DEFAULT_BACKEND_URL,
    keyUID: raw.keyUID,
    password,
    dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
    displayName: raw.displayName ?? DEFAULT_DISPLAY_NAME,
    configured: password.length > 0,
    enabled: raw.enabled !== false,
  };
}
