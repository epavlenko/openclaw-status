import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommunityTool, parseToolResult } from "../src/community-tool.js";
import { loadCommunityStore } from "../src/community-store.js";

// Mock getActiveClient — no gateway running by default
vi.mock("../src/channel.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/channel.js")>();
  return {
    ...orig,
    getActiveClient: vi.fn(() => undefined),
  };
});

import { getActiveClient } from "../src/channel.js";
const mockGetActiveClient = vi.mocked(getActiveClient);

function makeConfig(dataDir: string, communityIds?: string[]) {
  return {
    plugins: {
      entries: {
        "openclaw-status": {
          config: {
            password: "test-pass",
            dataDir,
            ...(communityIds ? { communityIds } : {}),
          },
        },
      },
    },
  };
}

describe("status_community tool", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "openclaw-status-tool-test-"));
    mockGetActiveClient.mockReturnValue(undefined);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("schema", () => {
    it("has correct name and required fields", () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      expect(tool.name).toBe("status_community");
      expect(tool.parameters.required).toEqual(["action"]);
      expect(tool.parameters.properties.action.enum).toEqual(["join", "leave", "list"]);
    });
  });

  describe("action: join", () => {
    it("persists community ID and returns result (gateway offline)", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-1", { action: "join", communityId: "0x04abc123" }),
      );

      expect(result).toMatchObject({
        communityId: "0x04abc123",
        persisted: true,
        joinRequestSent: false,
      });

      // Verify persistence
      const store = await loadCommunityStore(dataDir);
      expect(store.communityIds).toContain("0x04abc123");
    });

    it("parses status.app link and decodes multibase to hex", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-2", {
          action: "join",
          communityId: "https://status.app/c#zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57",
        }),
      );

      const expectedHex = "0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16";
      expect(result).toMatchObject({
        communityId: expectedHex,
        persisted: true,
      });

      const store = await loadCommunityStore(dataDir);
      expect(store.communityIds).toContain(expectedHex);
    });

    it("parses status.app/cc link (community channel)", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-3", {
          action: "join",
          communityId:
            "https://status.app/cc/G5kAAGRgnoPj#zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57",
        }),
      );

      expect(result).toMatchObject({
        communityId: "0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16",
        persisted: true,
      });
    });

    it("returns persisted=false for duplicate join", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await tool.execute("test-4a", { action: "join", communityId: "0xdup" });
      const result = parseToolResult(
        await tool.execute("test-4b", { action: "join", communityId: "0xdup" }),
      );

      expect(result).toMatchObject({ persisted: false });
    });

    it("sends join RPC when gateway is active and not already joined", async () => {
      const mockJoinCommunity = vi.fn().mockResolvedValue({});
      const mockJoinedCommunities = vi.fn().mockResolvedValue([]);

      mockGetActiveClient.mockReturnValue({
        client: {
          joinCommunity: mockJoinCommunity,
          joinedCommunities: mockJoinedCommunities,
        },
        abortController: new AbortController(),
      } as never);

      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-5", { action: "join", communityId: "0x04newcommunity" }),
      );

      expect(result).toMatchObject({
        communityId: "0x04newcommunity",
        persisted: true,
        joinRequestSent: true,
        alreadyJoined: false,
      });
      expect(mockJoinCommunity).toHaveBeenCalledWith("0x04newcommunity");
    });

    it("skips join RPC when already a member", async () => {
      const mockJoinCommunity = vi.fn();
      const mockJoinedCommunities = vi
        .fn()
        .mockResolvedValue([{ id: "0x04already", joined: true }]);

      mockGetActiveClient.mockReturnValue({
        client: {
          joinCommunity: mockJoinCommunity,
          joinedCommunities: mockJoinedCommunities,
        },
        abortController: new AbortController(),
      } as never);

      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-6", { action: "join", communityId: "0x04already" }),
      );

      expect(result).toMatchObject({
        alreadyJoined: true,
        joinRequestSent: false,
      });
      expect(mockJoinCommunity).not.toHaveBeenCalled();
    });

    it("throws when communityId is missing", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await expect(
        tool.execute("test-7", { action: "join" }),
      ).rejects.toThrow("communityId is required");
    });
  });

  describe("action: leave", () => {
    it("removes a previously joined community", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await tool.execute("test-8a", { action: "join", communityId: "0xtoremove" });

      const result = parseToolResult(
        await tool.execute("test-8b", { action: "leave", communityId: "0xtoremove" }),
      );
      expect(result).toMatchObject({ removed: true });

      const store = await loadCommunityStore(dataDir);
      expect(store.communityIds).not.toContain("0xtoremove");
    });

    it("returns removed=false for unknown community", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-9", { action: "leave", communityId: "0xnothere" }),
      );
      expect(result).toMatchObject({ removed: false });
    });

    it("throws when communityId is missing", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await expect(
        tool.execute("test-10", { action: "leave" }),
      ).rejects.toThrow("communityId is required");
    });
  });

  describe("action: list", () => {
    it("returns empty lists when nothing configured", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-11", { action: "list" }),
      ) as Record<string, unknown>;

      expect(result.configCommunityIds).toEqual([]);
      expect(result.savedCommunityIds).toEqual([]);
      expect(result.joinedCommunities).toEqual([]);
    });

    it("shows config community IDs", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir, ["0xcfg1", "0xcfg2"]));
      const result = parseToolResult(
        await tool.execute("test-12", { action: "list" }),
      ) as Record<string, unknown>;

      expect(result.configCommunityIds).toEqual(["0xcfg1", "0xcfg2"]);
    });

    it("shows saved community IDs after join", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await tool.execute("test-13a", { action: "join", communityId: "0xsaved1" });
      await tool.execute("test-13b", { action: "join", communityId: "0xsaved2" });

      const result = parseToolResult(
        await tool.execute("test-13c", { action: "list" }),
      ) as Record<string, unknown>;

      expect(result.savedCommunityIds).toEqual(["0xsaved1", "0xsaved2"]);
    });

    it("includes joined communities from active client", async () => {
      const mockJoinedCommunities = vi.fn().mockResolvedValue([
        { id: "0xremote1", name: "Test Community", joined: true },
        { id: "0xremote2", name: "Other Community", joined: true },
      ]);

      mockGetActiveClient.mockReturnValue({
        client: {
          joinedCommunities: mockJoinedCommunities,
        },
        abortController: new AbortController(),
      } as never);

      const tool = buildCommunityTool(makeConfig(dataDir));
      const result = parseToolResult(
        await tool.execute("test-14", { action: "list" }),
      ) as Record<string, unknown>;

      expect(result.joinedCommunities).toEqual([
        { id: "0xremote1", name: "Test Community", joined: true },
        { id: "0xremote2", name: "Other Community", joined: true },
      ]);
    });
  });

  describe("full flow", () => {
    it("join → list → leave → list lifecycle", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));

      // Join two communities
      await tool.execute("flow-1", { action: "join", communityId: "0xA" });
      await tool.execute("flow-2", { action: "join", communityId: "0xB" });

      // List — both should be saved
      let result = parseToolResult(
        await tool.execute("flow-3", { action: "list" }),
      ) as Record<string, unknown>;
      expect(result.savedCommunityIds).toEqual(["0xA", "0xB"]);

      // Leave one
      await tool.execute("flow-4", { action: "leave", communityId: "0xA" });

      // List — only B remains
      result = parseToolResult(
        await tool.execute("flow-5", { action: "list" }),
      ) as Record<string, unknown>;
      expect(result.savedCommunityIds).toEqual(["0xB"]);
    });

    it("join via link → leave via parsed ID", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      const expectedHex = "0x03b3a11795c41bb46d7a33c1e21726327f80188c19ec1adbc06f00ac80ed06eb16";

      await tool.execute("flow-6", {
        action: "join",
        communityId: "https://status.app/c#zQ3shrjJaMaxPCL4FUeqCn96s3mUr1YhtYD17XxqerBhJTs57",
      });

      let result = parseToolResult(
        await tool.execute("flow-7", { action: "list" }),
      ) as Record<string, unknown>;
      expect(result.savedCommunityIds).toContain(expectedHex);

      // Leave using the same link (will be decoded to same hex)
      await tool.execute("flow-8", { action: "leave", communityId: expectedHex });

      result = parseToolResult(
        await tool.execute("flow-9", { action: "list" }),
      ) as Record<string, unknown>;
      expect(result.savedCommunityIds).not.toContain(expectedHex);
    });
  });

  describe("error handling", () => {
    it("throws on unknown action", async () => {
      const tool = buildCommunityTool(makeConfig(dataDir));
      await expect(
        tool.execute("err-1", { action: "unknown", communityId: "0xtest" }),
      ).rejects.toThrow("Unknown action: unknown");
    });
  });
});
