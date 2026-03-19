/**
 * Backend provisioning utilities for Status channel plugin.
 *
 * Used by gateway.startAccount to ensure status-backend is running:
 *   1. Health check — already running?
 *   2. Find binary — PATH, ~/.openclaw/bin/, common locations
 *   3. Download prebuilt binary from GitHub Release
 *   4. Start and wait for healthy
 */

import { existsSync, mkdirSync, openSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { StatusClient } from "./status-client.js";

// ---------------------------------------------------------------------------
// Paths & URLs
// ---------------------------------------------------------------------------

const OPENCLAW_BIN = resolve(homedir(), ".openclaw", "bin");
const STATUS_BACKEND_BIN = resolve(OPENCLAW_BIN, "status-backend");

const RELEASE_TAG = "status-backend-v0.1.0";
const RELEASE_REPO = "epavlenko/openclaw-status";

// ---------------------------------------------------------------------------
// Find existing binary
// ---------------------------------------------------------------------------

/** Search common locations for an existing status-backend binary. */
export function findBackendBinary(): string | null {
  // Explicit location from previous downloads/builds
  if (existsSync(STATUS_BACKEND_BIN)) return STATUS_BACKEND_BIN;

  // Check PATH
  try {
    const found = execSync("which status-backend", { stdio: "pipe" })
      .toString()
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    // not on PATH
  }

  // Common locations
  const candidates = [
    "/usr/local/bin/status-backend",
    resolve(homedir(), ".local", "bin", "status-backend"),
    resolve(homedir(), "go", "bin", "status-backend"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Download prebuilt binary
// ---------------------------------------------------------------------------

/**
 * Download prebuilt status-backend from GitHub Release.
 * Extracts status-backend + libsds.so to ~/.openclaw/bin/.
 */
export function downloadBackendBinary(): { path: string } | { error: string } {
  const existing = findBackendBinary();
  if (existing) return { path: existing };

  try {
    mkdirSync(OPENCLAW_BIN, { recursive: true });

    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const pattern = `status-backend-${platform}-${arch}.tar.gz`;

    console.log(`[status] Downloading status-backend (${RELEASE_TAG}, ${pattern})...`);
    execSync(
      `gh release download "${RELEASE_TAG}" --repo "${RELEASE_REPO}" --pattern "${pattern}" --dir /tmp --clobber` +
      ` && tar xzf "/tmp/${pattern}" -C "${OPENCLAW_BIN}" && rm -f "/tmp/${pattern}"`,
      { stdio: "pipe", timeout: 120_000 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error:
        `Failed to download status-backend: ${msg}\n` +
        "Ensure GitHub CLI (gh) is installed and authenticated.\n" +
        "Or manually set the path:\n" +
        '  openclaw config set plugins.entries.openclaw-status.config.backendBinary "/path/to/status-backend"',
    };
  }

  if (existsSync(STATUS_BACKEND_BIN)) {
    console.log(`[status] Downloaded status-backend to ${STATUS_BACKEND_BIN}`);
    return { path: STATUS_BACKEND_BIN };
  }
  return { error: "Download completed but binary not found in archive." };
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/** Poll a URL until it responds or timeout is reached. */
export async function waitForHealthy(
  url: string,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<boolean> {
  const client = new StatusClient({ baseUrl: url });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.health();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

/**
 * Start status-backend as a detached background process.
 * Sets LD_LIBRARY_PATH so libsds.so is found next to the binary.
 */
export function startBackendProcess(
  binaryPath: string,
  port: number,
): ChildProcess | null {
  const abs = resolve(binaryPath);
  if (!existsSync(abs)) return null;

  const binDir = resolve(abs, "..");
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: `${binDir}:${process.env.LD_LIBRARY_PATH ?? ""}`,
    DYLD_LIBRARY_PATH: `${binDir}:${process.env.DYLD_LIBRARY_PATH ?? ""}`,
  };

  // Log to file instead of /dev/null — critical for debugging Go-side errors
  const logDir = join(homedir(), ".openclaw", "data", "openclaw-status");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, "status-backend.log"), "a");

  const child = spawn(abs, ["--address", `127.0.0.1:${port}`], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  return child;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensure status-backend is reachable at `url`.
 *
 *   1. Already running? → done
 *   2. Explicit binaryPath? → use it
 *   3. Find on PATH / common locations
 *   4. Not found → download prebuilt from GitHub Release
 *   5. Start and wait for healthy
 */
export async function ensureBackend(
  url: string,
  binaryPath?: string,
): Promise<{ ok: boolean; started: boolean; binaryPath?: string; error?: string }> {
  // 1. Already running?
  const client = new StatusClient({ baseUrl: url });
  try {
    await client.health();
    return { ok: true, started: false };
  } catch {
    // not running
  }

  // 2–4. Resolve binary
  let resolvedBinary: string | undefined;

  if (binaryPath?.trim()) {
    const abs = resolve(binaryPath);
    if (!existsSync(abs)) {
      return { ok: false, started: false, error: `Binary not found at ${abs}.` };
    }
    resolvedBinary = abs;
  } else {
    const found = findBackendBinary();
    if (found) {
      resolvedBinary = found;
    } else {
      const dlResult = downloadBackendBinary();
      if ("error" in dlResult) {
        return { ok: false, started: false, error: dlResult.error };
      }
      resolvedBinary = dlResult.path;
    }
  }

  // 5. Start
  let port = 12345;
  try {
    const parsed = new URL(url);
    if (parsed.port) port = Number(parsed.port);
  } catch {
    // use default
  }

  const child = startBackendProcess(resolvedBinary, port);
  if (!child) {
    return { ok: false, started: false, error: `Failed to spawn ${resolvedBinary}.` };
  }

  const healthy = await waitForHealthy(url);
  if (!healthy) {
    return {
      ok: false,
      started: true,
      error: `Started ${resolvedBinary} but it did not become healthy within 10 s.`,
    };
  }

  return { ok: true, started: true, binaryPath: resolvedBinary };
}
