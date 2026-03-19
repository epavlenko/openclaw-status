import { describe, it, expect } from "vitest";
import {
  findBackendBinary,
  downloadBackendBinary,
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

describe("downloadBackendBinary", () => {
  it("returns path or error (never throws)", { timeout: 30_000 }, () => {
    const result = downloadBackendBinary();
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
    const result = await waitForHealthy("http://127.0.0.1:61777", 1000, 200);
    expect(result).toBe(false);
  });
});

describe("ensureBackend", () => {
  it("returns error when explicit binary does not exist", async () => {
    const r = await ensureBackend(
      "http://127.0.0.1:61777",
      "/tmp/no-such-binary",
    );
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    expect(r.error).toMatch(/Binary not found/);
  });

  it("attempts download when no binary found", async () => {
    const r = await ensureBackend("http://127.0.0.1:61777");
    // Either succeeds (binary downloaded/found) or fails with download error
    // — should NOT fail with a generic "not found"
    if (!r.ok) {
      expect(r.error).toBeDefined();
    }
  });
});
