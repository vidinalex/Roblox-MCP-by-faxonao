import { randomUUID } from "node:crypto";
import { BridgeCommand, CommandResult } from "../domain/types.js";
import { BridgeError } from "../lib/errors.js";

interface PendingCommandState {
  command: BridgeCommand;
  resolve: (value: CommandResult["result"]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EnqueuedCommand {
  command: BridgeCommand;
  result: Promise<Record<string, unknown> | undefined>;
}

export class CommandQueue {
  private activeSessionId: string | null = null;
  private queue: BridgeCommand[] = [];
  private pending = new Map<string, PendingCommandState>();
  private pollWaiters: Array<() => void> = [];

  bindSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) {
      return;
    }
    this.failAll(new BridgeError("session_replaced", "Studio session replaced", 409));
    this.activeSessionId = sessionId;
  }

  hasBoundSession(): boolean {
    return this.activeSessionId !== null;
  }

  get boundSessionId(): string | null {
    return this.activeSessionId;
  }

  async enqueue(
    type: BridgeCommand["type"],
    payload: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<Record<string, unknown> | undefined> {
    const pending = this.enqueueDetailed(type, payload, timeoutMs);
    return pending.result;
  }

  enqueueDetailed(
    type: BridgeCommand["type"],
    payload: Record<string, unknown>,
    timeoutMs = 15_000
  ): EnqueuedCommand {
    if (!this.activeSessionId) {
      throw new BridgeError("studio_offline", "No active Studio session", 503);
    }

    const command: BridgeCommand = {
      commandId: randomUUID(),
      sessionId: this.activeSessionId,
      type,
      payload,
      createdAt: new Date().toISOString(),
      timeoutMs,
      requestId: typeof payload.requestId === "string" ? payload.requestId : undefined
    };

    const promise = new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId);
        reject(new BridgeError("timeout", `Command ${command.type} timed out`, 504));
      }, timeoutMs);
      this.pending.set(command.commandId, { command, resolve, reject, timer });
    });

    this.queue.push(command);
    this.notifyPollWaiters();
    return { command, result: promise };
  }

  async poll(sessionId: string, waitMs = 25_000, maxCommands = 1): Promise<BridgeCommand[]> {
    this.assertSession(sessionId);

    const readNow = this.dequeueForSession(sessionId, maxCommands);
    if (readNow.length > 0 || waitMs <= 0) {
      return readNow;
    }

    return new Promise<BridgeCommand[]>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve([]);
      }, waitMs);

      const wake = (): void => {
        const ready = this.dequeueForSession(sessionId, maxCommands);
        if (ready.length === 0) {
          return;
        }
        cleanup();
        resolve(ready);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.pollWaiters = this.pollWaiters.filter((entry) => entry !== wake);
      };

      this.pollWaiters.push(wake);
    });
  }

  complete(sessionId: string, commandId: string, outcome: CommandResult): BridgeCommand {
    this.assertSession(sessionId);
    const pending = this.pending.get(commandId);
    if (!pending) {
      throw new BridgeError("unknown_command", "Unknown commandId", 404);
    }
    clearTimeout(pending.timer);
    this.pending.delete(commandId);

    if (!outcome.ok) {
      const error = outcome.error;
      pending.reject(
        new BridgeError(error?.code ?? "plugin_error", error?.message ?? "Plugin command failed", 409, error?.details)
      );
      return pending.command;
    }
    pending.resolve(outcome.result);
    return pending.command;
  }

  private dequeueForSession(sessionId: string, maxCommands: number): BridgeCommand[] {
    const out: BridgeCommand[] = [];
    const keep: BridgeCommand[] = [];
    for (const command of this.queue) {
      if (out.length < maxCommands && command.sessionId === sessionId) {
        out.push(command);
      } else {
        keep.push(command);
      }
    }
    this.queue = keep;
    return out;
  }

  private assertSession(sessionId: string): void {
    if (!this.activeSessionId || this.activeSessionId !== sessionId) {
      throw new BridgeError("invalid_session", "Session is not active", 409);
    }
  }

  private notifyPollWaiters(): void {
    const waiters = [...this.pollWaiters];
    for (const wake of waiters) {
      wake();
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.queue = [];
    this.notifyPollWaiters();
  }
}
