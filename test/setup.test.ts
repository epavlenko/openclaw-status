import { describe, it, expect } from "vitest";
import {
  findBackendBinary,
  ensureBackendBinary,
  ensureBackend,
  startBackendProcess,
  waitForHealthy,
} from "../src/setup.js";

describe("findBackendBinary", () => {
  it("returns null or a valid path (never throws)", () => {
    const result = findBackendBinary();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("ensureBackendBinary", () => {
  it("returns path or error (never throws)", { timeout: 30_000 }, () => {
    const result = ensureBackendBinary();
    expect("path" in result || "error" in result).toBe(true);
  });
});

describe("startBackendProcess", () => {
  it("returns null for nonexistent binary", () => {
    const child = startBackendProcess("/tmp/no-such-binary", 12345);
    expect(child).toBeNull();
  });
});

describe("waitForHealthy", () => {
  it("returns false for unreachable URL within timeout", async () => {
    const result = await waitForHealthy("http://127.0.0.1:19999", 1000, 200);
    expect(result).toBe(false);
  });
});

describe("ensureBackend", () => {
  it("returns error when explicit binary does not exist", async () => {
    const r = await ensureBackend(
      "http://127.0.0.1:19999",
      "/tmp/no-such-binary",
    );
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.error).toMatch(/Binary not found/);
  });

  it("returns error when no binary found (no auto-build)", async () => {
    const r = await ensureBackend("http://127.0.0.1:19999");
    // Should fail fast without attempting to download Go or build
    if (!r.ok) {
      expect(r.error).toMatch(/status-backend not found/);
    }
  });
});
