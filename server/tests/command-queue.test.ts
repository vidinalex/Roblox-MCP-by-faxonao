import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandQueue } from "../src/bridge/commandQueue.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandQueue", () => {
  it("enqueues, polls and resolves command", async () => {
    const queue = new CommandQueue();
    queue.bindSession("session-1");

    const pending = queue.enqueue("snapshot_all_scripts", {}, 1000);
    const commands = await queue.poll("session-1", 10, 1);
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe("snapshot_all_scripts");

    queue.complete("session-1", commands[0].commandId, { ok: true, result: { count: 3 } });
    await expect(pending).resolves.toEqual({ count: 3 });
  });

  it("times out pending command", async () => {
    const queue = new CommandQueue();
    queue.bindSession("session-1");

    const pending = queue.enqueue("snapshot_all_scripts", {}, 20);
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("rejects old pending when session changes", async () => {
    const queue = new CommandQueue();
    queue.bindSession("session-1");
    const pending = queue.enqueue("snapshot_all_scripts", {}, 1000);

    queue.bindSession("session-2");
    await expect(pending).rejects.toThrow(/replaced/);
  });

  it("respects custom timeout and does not reject early", async () => {
    vi.useFakeTimers();
    const queue = new CommandQueue();
    queue.bindSession("session-1");

    const pending = queue.enqueue("upsert_script", {}, 45_000);
    await vi.advanceTimersByTimeAsync(44_999);
    const beforeDeadline = await Promise.race([
      pending.then(() => "resolved", () => "rejected"),
      Promise.resolve("pending")
    ]);
    expect(beforeDeadline).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("returns immediately when waitMs is zero and there are no queued commands", async () => {
    const queue = new CommandQueue();
    queue.bindSession("session-1");

    await expect(queue.poll("session-1", 0, 1)).resolves.toEqual([]);
  });
});
