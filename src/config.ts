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
  backendBinary?: string;
  keyUID?: string;
  password?: string;
  dataDir?: string;
  displayName?: string;
  communityIds?: string | string[];
  enabled?: boolean;
}

export interface ResolvedStatusAccount {
  accountId: string;
  backendUrl: string;
  backendBinary: string | undefined;
  keyUID: string | undefined;
  password: string;
  dataDir: string;
  displayName: string;
  communityIds: string[];
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

/**
 * Read account config from OpenClaw config.
 *
 * Priority:
 *   1. plugins.entries.openclaw-status.config  (how OpenClaw stores plugin config)
 *   2. channels.status                          (backward compatibility)
 */
function readAccountsBlock(
  cfg: Record<string, unknown>,
): Record<string, StatusAccountConfig> {
  // 1. Plugin config path (primary)
  const plugins = cfg?.["plugins"] as Record<string, unknown> | undefined;
  const entries = plugins?.["entries"] as Record<string, unknown> | undefined;
  const pluginEntry = entries?.["openclaw-status"] as Record<string, unknown> | undefined;
  const pluginConfig = pluginEntry?.["config"] as Record<string, unknown> | undefined;

  if (pluginConfig) {
    const accounts = pluginConfig["accounts"] as
      | Record<string, StatusAccountConfig>
      | undefined;
    if (accounts) return accounts;
    return { [DEFAULT_ACCOUNT_ID]: pluginConfig as unknown as StatusAccountConfig };
  }

  // 2. Channel config path (backward compatibility)
  const channels = cfg?.["channels"] as Record<string, unknown> | undefined;
  const status = channels?.["status"] as Record<string, unknown> | undefined;

  if (!status) return {};

  const accounts = status["accounts"] as
    | Record<string, StatusAccountConfig>
    | undefined;
  if (accounts) return accounts;
  return { [DEFAULT_ACCOUNT_ID]: status as unknown as StatusAccountConfig };
}

function normalizeCommunityIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => s.length > 0);
  return raw.length > 0 ? [raw] : [];
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
    backendBinary: raw.backendBinary,
    keyUID: raw.keyUID,
    password,
    dataDir: raw.dataDir ?? DEFAULT_DATA_DIR,
    displayName: raw.displayName ?? DEFAULT_DISPLAY_NAME,
    communityIds: normalizeCommunityIds(raw.communityIds),
    configured: password.length > 0,
    enabled: raw.enabled !== false,
  };
}
