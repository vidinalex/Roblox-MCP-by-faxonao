import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildExecutePrompt, buildTriagePrompt } from "./prompts.mjs";

function ensureArray(value) {
  return Array.isArray(value) ? value.filter((entry) => String(entry ?? "").trim()) : [];
}

export class AutomationWorkerService {
  constructor(options) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.launcherBridge = options.launcherBridge;
    this.artifactsDir = options.artifactsDir;
    this.projectMappings = options.projectMappings || [];
    this.notifier = options.notifier;
  }

  findProjectMapping(profileId) {
    return this.projectMappings.find((entry) => entry.launcherProfileId === profileId || entry.id === profileId) || null;
  }

  async notifyTask(taskId, buildNotifications) {
    const links = this.store.listLinks(taskId);
    const telegramLinks = links.filter((entry) => entry.linkType === "telegram_chat");
    const linearLinks = links.filter((entry) => entry.linkType === "linear_issue");

    for (const link of telegramLinks) {
      const text = buildNotifications("telegram", link);
      if (text) {
        await this.notifier.send({
          channel: "telegram",
          chatId: link.externalId,
          taskId,
          text
        });
      }
    }

    for (const link of linearLinks) {
      const text = buildNotifications("linear", link);
      if (text) {
        await this.notifier.send({
          channel: "linear",
          issueId: link.externalId,
          taskId,
          text
        });
      }
    }
  }

  async runTriage(taskId) {
    const snapshot = this.store.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const mapping = this.findProjectMapping(snapshot.task.projectProfileId);
    const run = this.store.createRun(taskId, {
      mode: "triage",
      status: "running",
      runtime: this.adapter.config.runtime,
      input: snapshot
    });

    try {
      const prompt = buildTriagePrompt(snapshot.task, { projectMappings: this.projectMappings });
      const result = await this.adapter.run("triage", {
        workspacePath: mapping?.workspacePath || process.cwd(),
        task: snapshot.task,
        snapshot,
        prompt
      });

      const payload = result.raw;
      const questions = ensureArray(payload.questions);
      const nextState = payload.recommendedState || (questions.length > 0 ? "needs_clarification" : "ready_for_execution");

      this.store.updateTask(taskId, {
        title: payload.normalizedTitle || snapshot.task.title,
        taskType: payload.taskType || snapshot.task.taskType,
        projectProfileId: payload.projectProfileId || snapshot.task.projectProfileId,
        placeId: payload.placeId || snapshot.task.placeId,
        requiresStudio: payload.requiresStudio === true,
        requiresManualVerification: payload.requiresManualVerification === true,
        requiresClarification: questions.length > 0 || payload.requiresClarification === true,
        acceptanceCriteria: ensureArray(payload.acceptanceCriteria),
        executorPrompt: payload.executorPrompt || snapshot.task.executorPrompt,
        triageSummary: payload.triageSummary || snapshot.task.triageSummary,
        blockedReason: nextState === "blocked_manual" ? (payload.blockedReason || "Manual preparation is required.") : "",
        state: nextState
      });

      this.store.replaceOpenQuestions(taskId, questions);

      const finishedRun = this.store.finishRun(run.id, {
        status: "completed",
        summary: payload.triageSummary || "Triage completed.",
        output: payload
      });

      await this.notifyTask(taskId, (channel) => {
        const task = this.store.getTask(taskId);
        if (!task) {
          return "";
        }
        if (channel === "telegram") {
          if (questions.length > 0) {
            return [
              `Task ${task.id}: ${task.triageSummary || "Clarification is required."}`,
              "",
              ...questions.map((question, index) => `${index + 1}. ${question}`),
              "",
              `Reply in this chat or run "run ${task.id}" once the task is clarified.`
            ].join("\n");
          }
          if (task.state === "ready_for_execution") {
            return [
              `Task ${task.id} is ready for execution.`,
              task.triageSummary || "",
              "",
              `Run: run ${task.id}`
            ].filter(Boolean).join("\n");
          }
          if (task.state === "blocked_manual") {
            return `Task ${task.id} is blocked: ${task.blockedReason}`;
          }
        }
        return channel === "linear" ? `${this.store.getTask(taskId)?.triageSummary || "Triage complete."}` : "";
      });

      return finishedRun;
    } catch (error) {
      const finishedRun = this.store.finishRun(run.id, {
        status: "failed",
        summary: "Triage failed.",
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      const task = this.store.updateTask(taskId, {
        state: "failed",
        blockedReason: error instanceof Error ? error.message : String(error)
      });
      await this.notifyTask(taskId, (channel) => channel === "telegram"
        ? `Task ${task.id} triage failed: ${task.blockedReason}`
        : `Triage failed: ${task.blockedReason}`);
      return finishedRun;
    }
  }

  async runExecution(taskId) {
    const snapshot = this.store.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const profile = snapshot.task.projectProfileId ? this.store.getProjectProfile(snapshot.task.projectProfileId) : null;
    if (snapshot.task.projectProfileId) {
      const readiness = await this.launcherBridge.ensureTaskReady(profile, {
        requiresStudio: snapshot.task.requiresStudio,
        requiresWrite: true
      });
      if (!readiness.ok) {
        const task = this.store.updateTask(taskId, {
          state: "blocked_manual",
          blockedReason: readiness.reason
        });
        await this.notifyTask(taskId, (channel) => channel === "telegram"
          ? `Task ${task.id} is waiting for a manual step: ${readiness.action}`
          : `Blocked: ${readiness.reason}`);
        return null;
      }
    }

    this.store.updateTask(taskId, {
      state: "executing",
      blockedReason: ""
    });

    const run = this.store.createRun(taskId, {
      mode: "execute",
      status: "running",
      runtime: this.adapter.config.runtime,
      input: snapshot
    });

    try {
      const prompt = buildExecutePrompt(snapshot.task, {
        readiness: profile ? await this.launcherBridge.getMcpHealth(profile.port).catch(() => ({})) : {}
      });
      const result = await this.adapter.run("execute", {
        workspacePath: profile?.workspacePath || process.cwd(),
        task: snapshot.task,
        snapshot,
        prompt
      });

      const payload = result.raw;
      const task = this.store.updateTask(taskId, {
        state: payload.recommendedState || payload.outcomeStatus || "review",
        executionSummary: payload.summary || "Execution finished.",
        blockedReason: payload.blockedReason || ""
      });

      await mkdir(this.artifactsDir, { recursive: true });
      for (const artifact of Array.isArray(payload.artifacts) ? payload.artifacts : []) {
        if (!artifact.path) {
          const filePath = join(this.artifactsDir, `${taskId}-${Date.now()}.txt`);
          await writeFile(filePath, payload.summary || "", "utf8");
          this.store.addArtifact(taskId, {
            runId: run.id,
            kind: artifact.kind || "summary",
            label: artifact.label || "summary",
            path: filePath,
            meta: artifact
          });
        } else {
          this.store.addArtifact(taskId, {
            runId: run.id,
            kind: artifact.kind || "file",
            label: artifact.label || "artifact",
            path: artifact.path,
            meta: artifact
          });
        }
      }

      const finishedRun = this.store.finishRun(run.id, {
        status: "completed",
        summary: payload.summary || "Execution finished.",
        output: payload
      });

      await this.notifyTask(taskId, (channel) => {
        if (channel === "telegram") {
          return [
            `Task ${task.id}: ${task.executionSummary || "Execution finished."}`,
            `State: ${task.state}`,
            task.blockedReason ? `Blocked reason: ${task.blockedReason}` : ""
          ].filter(Boolean).join("\n");
        }
        return `${task.executionSummary || "Execution finished."}\nState: ${task.state}`;
      });

      return finishedRun;
    } catch (error) {
      const finishedRun = this.store.finishRun(run.id, {
        status: "failed",
        summary: "Execution failed.",
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      const task = this.store.updateTask(taskId, {
        state: "failed",
        blockedReason: error instanceof Error ? error.message : String(error)
      });
      await this.notifyTask(taskId, (channel) => channel === "telegram"
        ? `Task ${task.id} execution failed: ${task.blockedReason}`
        : `Execution failed: ${task.blockedReason}`);
      return finishedRun;
    }
  }
}
