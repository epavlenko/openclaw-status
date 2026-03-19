import { describe, it, expect } from "vitest";
import { statusPlugin, parseCommunityId, decodeMultibaseCommunityKey } from "../src/channel.js";

describe("statusPlugin contract", () => {
  it("has required id", () => {
    expect(statusPlugin.id).toBe("status");
  });

  it("has required meta fields", () => {
    expect(statusPlugin.meta.id).toBe("status");
    expect(statusPlugin.meta.label).toBe("Status");
    expect(statusPlugin.meta.selectionLabel).toBe("Status App");
    expect(typeof statusPlugin.meta.docsPath).toBe("string");
    expect(typeof statusPlugin.meta.blurb).toBe("string");
  });

  it("declares group chat type", () => {
    expect(statusPlugin.capabilities.chatTypes).toContain("group");
  });

  it("has config adapter with required methods", () => {
    expect(typeof statusPlugin.config.listAccountIds).toBe("function");
    expect(typeof statusPlugin.config.resolveAccount).toBe("function");
    expect(typeof statusPlugin.config.defaultAccountId).toBe("function");
    expect(typeof statusPlugin.config.isConfigured).toBe("function");
    expect(typeof statusPlugin.config.describeAccount).toBe("function");
  });

  it("has gateway adapter with startAccount", () => {
    expect(typeof statusPlugin.gateway.startAccount).toBe("function");
  });

  it("has outbound adapter with sendText", () => {
    expect(statusPlugin.outbound.deliveryMode).toBe("direct");
    expect(typeof statusPlugin.outbound.sendText).toBe("function");
    expect(typeof statusPlugin.outbound.textChunkLimit).toBe("number");
  });

  it("does not expose a setup adapter (OpenClaw manages config)", () => {
    expect((statusPlugin as Record<string, unknown>)["setup"]).toBeUndefined();
  });

  describe("decodeMultibaseCommunityKey", () => {
    it("returns hex ID as-is", () => {
      expect(decodeMultibaseCommunityKey("0x04abc123")).toBe("0x04abc123");
    });

    it("decodes zQ3 multibase key to hex compressed pubkey", () => {
      const key = "zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57";
      const hex = decodeMultibaseCommunityKey(key);
      expect(hex).toMatch(/^0x03[0-9a-f]{64}$/);
      expect(hex).toBe("0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16");
    });

    it("returns non-multibase string with 0x prefix", () => {
      const result = decodeMultibaseCommunityKey("plainKey");
      expect(result).toBe("plainKey");
    });
  });

  describe("parseCommunityId", () => {
    it("returns raw hex ID as-is", () => {
      expect(parseCommunityId("0x04abc123")).toBe("0x04abc123");
    });

    it("trims whitespace from hex ID", () => {
      expect(parseCommunityId("  0x04abc123  ")).toBe("0x04abc123");
    });

    it("decodes multibase key from status.app link", () => {
      const result = parseCommunityId("https://status.app/c#zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57");
      expect(result).toBe("0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16");
    });

    it("decodes multibase key from status.app/cc link", () => {
      const result = parseCommunityId("https://status.app/cc/G5kAAtest#zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57");
      expect(result).toBe("0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16");
    });

    it("returns non-URL non-hex string as-is", () => {
      expect(parseCommunityId("someCommunityKey")).toBe("someCommunityKey");
    });
  });

  it("config.listAccountIds works with empty config", () => {
    expect(statusPlugin.config.listAccountIds({})).toEqual([]);
  });

  it("config.resolveAccount returns defaults for empty config", () => {
    const account = statusPlugin.config.resolveAccount({});
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(false);
  });

  it("config.isConfigured returns false for unconfigured account", () => {
    const account = statusPlugin.config.resolveAccount({});
    expect(statusPlugin.config.isConfigured(account)).toBe(false);
  });

  it("config.describeAccount returns snapshot shape", () => {
    const account = statusPlugin.config.resolveAccount({});
    const desc = statusPlugin.config.describeAccount(account);
    expect(desc).toHaveProperty("accountId");
    expect(desc).toHaveProperty("name");
    expect(desc).toHaveProperty("enabled");
    expect(desc).toHaveProperty("configured");
  });
});
