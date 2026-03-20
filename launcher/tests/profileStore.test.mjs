import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LauncherProfileStore } from "../src/profileStore.mjs";

const tempDirs = [];

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "rbxmcp-launcher-store-"));
  tempDirs.push(dir);
  return new LauncherProfileStore({
    filePath: join(dir, "profiles.json"),
    defaultWorkspacePath: "C:\\repo"
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LauncherProfileStore", () => {
  it("creates, updates and deletes profiles", async () => {
    const store = await createStore();
    const created = await store.createProfile({
      name: "Arena",
      workspacePath: "C:\\repo",
      port: "5111",
      expectedPlaceId: "83003959412113"
    });
    expect(created.stdioMode).toBe("off");

    const updated = await store.updateProfile(created.id, {
      favorite: true,
      name: "Arena Main"
    });
    expect(updated.favorite).toBe(true);
    expect(updated.name).toBe("Arena Main");

    await store.deleteProfile(created.id);
    expect(await store.listProfiles()).toEqual([]);
  });

  it("duplicates profile to next free port", async () => {
    const store = await createStore();
    const source = await store.createProfile({
      name: "Arena",
      workspacePath: "C:\\repo",
      port: "5111"
    });
    const duplicate = await store.duplicateProfile(source.id);
    expect(duplicate.port).toBe("5112");
    expect(duplicate.name).toContain("Copy");
  });

  it("rejects duplicate ports", async () => {
    const store = await createStore();
    await store.createProfile({
      name: "Arena",
      workspacePath: "C:\\repo",
      port: "5111"
    });
    await expect(store.createProfile({
      name: "Second",
      workspacePath: "C:\\repo",
      port: "5111"
    })).rejects.toThrow("Port 5111");
  });
});
