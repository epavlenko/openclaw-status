import { describe, it, expect } from "vitest";
import {
  listStatusAccountIds,
  resolveStatusAccount,
  resolveDefaultStatusAccountId,
} from "../src/config.js";

describe("config", () => {
  describe("listStatusAccountIds", () => {
    it("returns empty array for empty config", () => {
      expect(listStatusAccountIds({})).toEqual([]);
    });

    it("returns ['default'] for flat config (no accounts block)", () => {
      const cfg = {
        channels: {
          status: {
            backendUrl: "http://localhost:12345",
            password: "test",
          },
        },
      };
      expect(listStatusAccountIds(cfg)).toEqual(["default"]);
    });

    it("returns account ids from accounts block", () => {
      const cfg = {
        channels: {
          status: {
            accounts: {
              bot1: { password: "pass1" },
              bot2: { password: "pass2" },
            },
          },
        },
      };
      expect(listStatusAccountIds(cfg)).toEqual(["bot1", "bot2"]);
    });
  });

  describe("resolveDefaultStatusAccountId", () => {
    it("returns 'default' when no accounts", () => {
      expect(resolveDefaultStatusAccountId({})).toBe("default");
    });

    it("returns first account id", () => {
      const cfg = {
        channels: {
          status: {
            accounts: {
              mybot: { password: "p" },
            },
          },
        },
      };
      expect(resolveDefaultStatusAccountId(cfg)).toBe("mybot");
    });
  });

  describe("resolveStatusAccount", () => {
    it("returns defaults for empty config", () => {
      const account = resolveStatusAccount({});
      expect(account.accountId).toBe("default");
      expect(account.backendUrl).toBe("http://127.0.0.1:12345");
      expect(account.displayName).toBe("OpenClaw");
      expect(account.configured).toBe(false);
      expect(account.enabled).toBe(true);
    });

    it("resolves flat config as default account", () => {
      const cfg = {
        channels: {
          status: {
            backendUrl: "http://myhost:9999",
            password: "secret",
            displayName: "MyBot",
          },
        },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.accountId).toBe("default");
      expect(account.backendUrl).toBe("http://myhost:9999");
      expect(account.password).toBe("secret");
      expect(account.displayName).toBe("MyBot");
      expect(account.configured).toBe(true);
    });

    it("resolves specific account from accounts block", () => {
      const cfg = {
        channels: {
          status: {
            accounts: {
              prod: {
                backendUrl: "http://prod:12345",
                password: "prodpass",
                keyUID: "0xabc",
                enabled: true,
              },
              staging: {
                password: "stagingpass",
                enabled: false,
              },
            },
          },
        },
      };

      const prod = resolveStatusAccount(cfg, "prod");
      expect(prod.backendUrl).toBe("http://prod:12345");
      expect(prod.password).toBe("prodpass");
      expect(prod.keyUID).toBe("0xabc");
      expect(prod.enabled).toBe(true);
      expect(prod.configured).toBe(true);

      const staging = resolveStatusAccount(cfg, "staging");
      expect(staging.enabled).toBe(false);
    });

    it("returns unconfigured account for unknown id", () => {
      const account = resolveStatusAccount({}, "nonexistent");
      expect(account.accountId).toBe("nonexistent");
      expect(account.configured).toBe(false);
    });

    it("resolves backendBinary when set", () => {
      const cfg = {
        channels: {
          status: {
            password: "test",
            backendBinary: "/usr/local/bin/status-backend",
          },
        },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.backendBinary).toBe("/usr/local/bin/status-backend");
    });

    it("backendBinary is undefined when not set", () => {
      const cfg = { channels: { status: { password: "test" } } };
      const account = resolveStatusAccount(cfg);
      expect(account.backendBinary).toBeUndefined();
    });

    it("resolves communityIds from a single string", () => {
      const cfg = {
        plugins: {
          entries: {
            "openclaw-status": {
              config: {
                password: "test",
                communityIds: "0x04abc123",
              },
            },
          },
        },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.communityIds).toEqual(["0x04abc123"]);
    });

    it("resolves communityIds from an array", () => {
      const cfg = {
        plugins: {
          entries: {
            "openclaw-status": {
              config: {
                password: "test",
                communityIds: ["0x04abc123", "0x04def456"],
              },
            },
          },
        },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.communityIds).toEqual(["0x04abc123", "0x04def456"]);
    });

    it("communityIds is empty array when not set", () => {
      const cfg = { channels: { status: { password: "test" } } };
      const account = resolveStatusAccount(cfg);
      expect(account.communityIds).toEqual([]);
    });
  });

  describe("plugins.entries config path (primary)", () => {
    it("reads flat config from plugins.entries.openclaw-status.config", () => {
      const cfg = {
        plugins: {
          entries: {
            "openclaw-status": {
              config: {
                backendUrl: "http://localhost:9999",
                password: "plugin-pass",
              },
            },
          },
        },
      };
      expect(listStatusAccountIds(cfg)).toEqual(["default"]);
      const account = resolveStatusAccount(cfg);
      expect(account.password).toBe("plugin-pass");
      expect(account.backendUrl).toBe("http://localhost:9999");
    });

    it("plugins.entries takes priority over channels.status", () => {
      const cfg = {
        plugins: {
          entries: {
            "openclaw-status": {
              config: { password: "from-plugin" },
            },
          },
        },
        channels: {
          status: { password: "from-channel" },
        },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.password).toBe("from-plugin");
    });

    it("falls back to channels.status when plugins.entries is absent", () => {
      const cfg = {
        channels: { status: { password: "fallback" } },
      };
      const account = resolveStatusAccount(cfg);
      expect(account.password).toBe("fallback");
    });
  });
});
