/**
 * Persistent store for dynamically joined communities.
 *
 * Communities added via the status_community tool are saved to a JSON file
 * in the plugin's dataDir. On gateway start, these are merged with the
 * static communityIds from config.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STORE_FILENAME = "communities.json";

function resolveDir(dataDir: string): string {
  if (dataDir.startsWith("~")) {
    return join(homedir(), dataDir.slice(1));
  }
  return dataDir;
}

function storePath(dataDir: string): string {
  return join(resolveDir(dataDir), STORE_FILENAME);
}

export interface CommunityStore {
  /** Community IDs added at runtime (not from config). */
  communityIds: string[];
}

export async function loadCommunityStore(dataDir: string): Promise<CommunityStore> {
  try {
    const raw = await readFile(storePath(dataDir), "utf-8");
    const data = JSON.parse(raw) as Partial<CommunityStore>;
    return { communityIds: Array.isArray(data.communityIds) ? data.communityIds : [] };
  } catch {
    return { communityIds: [] };
  }
}

export async function saveCommunityStore(dataDir: string, store: CommunityStore): Promise<void> {
  const p = storePath(dataDir);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export async function addCommunityId(dataDir: string, communityId: string): Promise<boolean> {
  const store = await loadCommunityStore(dataDir);
  if (store.communityIds.includes(communityId)) return false;
  store.communityIds.push(communityId);
  await saveCommunityStore(dataDir, store);
  return true;
}

export async function removeCommunityId(dataDir: string, communityId: string): Promise<boolean> {
  const store = await loadCommunityStore(dataDir);
  const idx = store.communityIds.indexOf(communityId);
  if (idx === -1) return false;
  store.communityIds.splice(idx, 1);
  await saveCommunityStore(dataDir, store);
  return true;
}
