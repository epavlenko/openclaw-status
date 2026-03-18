import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCommunityStore,
  saveCommunityStore,
  addCommunityId,
  removeCommunityId,
} from "../src/community-store.js";

describe("community-store", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "openclaw-status-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns empty store when file does not exist", async () => {
    const store = await loadCommunityStore(dataDir);
    expect(store.communityIds).toEqual([]);
  });

  it("saves and loads community IDs", async () => {
    await saveCommunityStore(dataDir, { communityIds: ["0xabc", "0xdef"] });
    const store = await loadCommunityStore(dataDir);
    expect(store.communityIds).toEqual(["0xabc", "0xdef"]);
  });

  it("addCommunityId appends and returns true", async () => {
    const added = await addCommunityId(dataDir, "0xabc");
    expect(added).toBe(true);
    const store = await loadCommunityStore(dataDir);
    expect(store.communityIds).toEqual(["0xabc"]);
  });

  it("addCommunityId returns false for duplicates", async () => {
    await addCommunityId(dataDir, "0xabc");
    const added = await addCommunityId(dataDir, "0xabc");
    expect(added).toBe(false);
    const store = await loadCommunityStore(dataDir);
    expect(store.communityIds).toEqual(["0xabc"]);
  });

  it("removeCommunityId removes and returns true", async () => {
    await addCommunityId(dataDir, "0xabc");
    await addCommunityId(dataDir, "0xdef");
    const removed = await removeCommunityId(dataDir, "0xabc");
    expect(removed).toBe(true);
    const store = await loadCommunityStore(dataDir);
    expect(store.communityIds).toEqual(["0xdef"]);
  });

  it("removeCommunityId returns false when not found", async () => {
    const removed = await removeCommunityId(dataDir, "0xnothere");
    expect(removed).toBe(false);
  });

  it("creates dataDir if it does not exist", async () => {
    const nested = join(dataDir, "deep", "nested");
    await addCommunityId(nested, "0xabc");
    const store = await loadCommunityStore(nested);
    expect(store.communityIds).toEqual(["0xabc"]);
  });
});
