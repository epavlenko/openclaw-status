/**
 * Backend provisioning utilities for Status channel plugin.
 *
 * Used by gateway.startAccount to ensure status-backend is running:
 *   1. Health check — already running?
 *   2. Find binary — PATH, ~/.openclaw/bin/, common locations
 *   3. Build from source — clone status-go, install Go if needed
 *   4. Start and wait for healthy
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { StatusClient } from "./status-client.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const OPENCLAW_BIN = resolve(homedir(), ".openclaw", "bin");
const STATUS_BACKEND_BIN = resolve(OPENCLAW_BIN, "status-backend");
const STATUS_GO_REPO = "https://github.com/status-im/status-go.git";
const STATUS_GO_DIR = resolve(homedir(), ".openclaw", "src", "status-go");

// ---------------------------------------------------------------------------
// Find existing binary
// ---------------------------------------------------------------------------

/** Search common locations for an existing status-backend binary. */
export function findBackendBinary(): string | null {
  // Explicit location from previous builds
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
// Go toolchain
// ---------------------------------------------------------------------------

/** Ensure Go toolchain is available, returns `go` binary path. */
export function ensureGo(): string | null {
  try {
    const found = execSync("which go", { stdio: "pipe" }).toString().trim();
    if (found) return found;
  } catch {
    // not on PATH
  }

  const localGo = resolve(homedir(), ".openclaw", "go", "bin", "go");
  if (existsSync(localGo)) return localGo;

  // Download portable Go
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const goVersion = "1.23.6";
  const tarball = `go${goVersion}.${platform}-${arch}.tar.gz`;
  const url = `https://go.dev/dl/${tarball}`;

  try {
    mkdirSync(resolve(homedir(), ".openclaw"), { recursive: true });
    execSync(
      `curl -fsSL "${url}" | tar -xz -C "${resolve(homedir(), ".openclaw")}"`,
      { stdio: "pipe", timeout: 120_000 },
    );
    if (existsSync(localGo)) return localGo;
  } catch {
    // download failed
  }

  return null;
}

// ---------------------------------------------------------------------------
// Build from source
// ---------------------------------------------------------------------------

/**
 * Ensure the status-backend binary exists.
 * Search → build from source (installing Go if needed).
 */
export function ensureBackendBinary(): { path: string } | { error: string } {
  const existing = findBackendBinary();
  if (existing) return { path: existing };

  const goBin = ensureGo();
  if (!goBin) {
    return { error: "Could not find or install Go toolchain. Install Go (https://go.dev/dl/) and retry." };
  }

  try {
    if (!existsSync(resolve(STATUS_GO_DIR, ".git"))) {
      mkdirSync(dirname(STATUS_GO_DIR), { recursive: true });
      execSync(
        `git clone --depth 1 ${STATUS_GO_REPO} "${STATUS_GO_DIR}"`,
        { stdio: "pipe", timeout: 120_000 },
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to clone status-go: ${msg}` };
  }

  try {
    mkdirSync(OPENCLAW_BIN, { recursive: true });
    const env = { ...process.env, GOBIN: OPENCLAW_BIN };
    execSync(
      `"${goBin}" build -o "${STATUS_BACKEND_BIN}" ./cmd/status-backend`,
      { cwd: STATUS_GO_DIR, stdio: "pipe", timeout: 300_000, env },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to build status-backend: ${msg}` };
  }

  if (existsSync(STATUS_BACKEND_BIN)) return { path: STATUS_BACKEND_BIN };
  return { error: "Build completed but binary not found." };
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
 * Returns the ChildProcess handle on success, or null if the binary doesn't exist.
 */
export function startBackendProcess(
  binaryPath: string,
  port: number,
): ChildProcess | null {
  const abs = resolve(binaryPath);
  if (!existsSync(abs)) return null;

  const child = spawn(abs, ["--port", String(port)], {
    detached: true,
    stdio: "ignore",
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
 * Lightweight — only finds an existing binary and starts it.
 * Does NOT download Go or build from source (use `ensureBackendBinary` for that).
 *
 *   1. Already running? → done
 *   2. Explicit binaryPath? → use it
 *   3. Find on PATH / common locations
 *   4. Not found → fail fast with instructions
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

  // 2–3. Resolve binary (lightweight — no build)
  let resolvedBinary: string | undefined;

  if (binaryPath?.trim()) {
    const abs = resolve(binaryPath);
    if (!existsSync(abs)) {
      return { ok: false, started: false, error: `Binary not found at ${abs}.` };
    }
    resolvedBinary = abs;
  } else {
    const found = findBackendBinary();
    if (!found) {
      return {
        ok: false,
        started: false,
        error:
          "status-backend not found. Install it and set the path:\n" +
          '  openclaw config set plugins.entries.openclaw-status.config.backendBinary "/path/to/status-backend"',
      };
    }
    resolvedBinary = found;
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
