import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheStore } from "../src/cache/cacheStore.js";
import { sourceHash } from "../src/lib/hash.js";

const tempDirs: string[] = [];

async function withStore() {
  const tempDir = await mkdtemp(join(tmpdir(), "rbxmcp-cache-"));
  tempDirs.push(tempDir);
  const store = new CacheStore(tempDir);
  await store.bootstrapFromDisk();
  await store.setActivePlace("place-1", "Arena");
  return store;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("CacheStore metadata", () => {
  it("stores draft metadata from snapshots", async () => {
    const store = await withStore();
    await store.snapshotAll(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path: ["ServerScriptService", "Main"],
          className: "Script",
          source: "print('x')",
          draftAware: true,
          readChannel: "editor"
        }
      ]
    );

    const script = await store.getScript(["ServerScriptService", "Main"]);
    expect(script?.draftAware).toBe(true);
    expect(script?.readChannel).toBe("editor");

    const listed = store.listScripts();
    expect(listed[0].draftAware).toBe(true);
    expect(listed[0].readChannel).toBe("editor");
    expect(store.metadata()?.lastReadChannel).toBe("editor");
  });

  it("persists write channel diagnostics", async () => {
    const store = await withStore();
    await store.setLastWriteChannel("editor");
    expect(store.metadata()?.lastWriteChannel).toBe("editor");
    expect(store.metadata()?.writeMode).toBe("draft_only");
  });

  it("uses plugin-provided hash from snapshot when present", async () => {
    const store = await withStore();
    await store.snapshotAll(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path: ["Workspace", "Script"],
          className: "Script",
          source: "warn (68)",
          hash: "43fd0b24",
          draftAware: true,
          readChannel: "editor"
        }
      ]
    );

    const script = await store.getScript(["Workspace", "Script"]);
    expect(script?.hash).toBe("43fd0b24");
    const listed = store.listScripts({ limit: 10 });
    expect(listed[0].hash).toBe("43fd0b24");
  });

  it("stores and retrieves ui roots and subtrees", async () => {
    const store = await withStore();
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: sourceHash("ui-root"),
      updatedAt: new Date().toISOString(),
      props: {
        DisplayOrder: 1,
        IgnoreGuiInset: false
      },
      unsupportedProperties: [],
      children: [
        {
          path: ["StarterGui", "MainGui", "TitleLabel"],
          service: "StarterGui",
          name: "TitleLabel",
          className: "TextLabel",
          version: sourceHash("ui-child"),
          updatedAt: new Date().toISOString(),
          props: {
            Text: "Hello",
            Visible: true
          },
          unsupportedProperties: [],
          children: []
        }
      ]
    };

    await store.snapshotUiRoots(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [root]
    );

    expect(store.uiRootCount()).toBe(1);
    expect(store.listUiRoots()[0].path).toEqual(["StarterGui", "MainGui"]);
    expect((await store.getUiRoot(["StarterGui", "MainGui"]))?.className).toBe("ScreenGui");
    expect((await store.getUiTree(["StarterGui", "MainGui", "TitleLabel"]))?.props.Text).toBe("Hello");
  });

  it("records and queries change journal by cursor and timestamp", async () => {
    const store = await withStore();
    const before = new Date().toISOString();
    await store.snapshotAll(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path: ["ServerScriptService", "Main"],
          className: "Script",
          source: "print('x')"
        }
      ]
    );
    await store.snapshotUiRoots(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path: ["StarterGui", "MainGui"],
          service: "StarterGui",
          name: "MainGui",
          className: "ScreenGui",
          version: sourceHash("ui-root"),
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: []
        }
      ]
    );

    const all = store.getChangedSince("");
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    expect(all.items.some((entry) => entry.kind === "script" && entry.changeType === "snapshot_all")).toBe(true);
    expect(all.items.some((entry) => entry.kind === "ui_root" && entry.changeType === "snapshot_all")).toBe(true);

    const afterCursor = store.getChangedSince(all.items[0].cursor);
    expect(afterCursor.items.every((entry) => Number.parseInt(entry.cursor, 10) > Number.parseInt(all.items[0].cursor, 10))).toBe(true);

    const afterTimestamp = store.getChangedSince(before);
    expect(afterTimestamp.items.length).toBeGreaterThanOrEqual(2);
    expect(afterTimestamp.nextCursor).toBeTruthy();
  });

  it("caps change journal responses with limit while preserving nextCursor", async () => {
    const store = await withStore();
    await store.snapshotAll(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path: ["ServerScriptService", "MainA"],
          className: "Script",
          source: "print('a')"
        },
        {
          path: ["ServerScriptService", "MainB"],
          className: "Script",
          source: "print('b')"
        }
      ]
    );
    await store.recordChangedItems("script", "script_write", [
      { path: ["ServerScriptService", "MainA"], updatedAt: new Date().toISOString() },
      { path: ["ServerScriptService", "MainB"], updatedAt: new Date().toISOString() }
    ]);

    const limited = store.getChangedSince("0", 2);
    expect(limited.items).toHaveLength(2);
    expect(limited.nextCursor).toBe(limited.items[1].cursor);

    const afterLimited = store.getChangedSince(limited.nextCursor ?? "0", 10);
    expect(afterLimited.items.length).toBeGreaterThan(0);
    expect(afterLimited.items.every((entry) => Number.parseInt(entry.cursor, 10) > Number.parseInt(limited.nextCursor ?? "0", 10))).toBe(true);
  });

  it("stores bounded script history for diff and review flows", async () => {
    const store = await withStore();
    const path = ["ServerScriptService", "Main"];
    await store.snapshotAll(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path,
          className: "Script",
          source: "print('v1')"
        }
      ]
    );

    await store.upsertMany(
      {
        placeId: "place-1",
        placeName: "Arena"
      },
      [
        {
          path,
          className: "Script",
          source: "print('v2')"
        }
      ]
    );

    const previous = await store.getPreviousScriptVersion(path);
    expect(previous?.source).toBe("print('v1')");

    const explicit = await store.getScriptVersion(path, sourceHash("print('v1')"));
    expect(explicit?.source).toBe("print('v1')");
  });
});
