import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createLogger } from "../shared/logger.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function toWslPath(filePath) {
  const value = normalizeText(filePath);
  if (!value) {
    return value;
  }
  if (value.startsWith("/")) {
    return value;
  }
  const normalized = value.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):(.*)$/);
  if (!driveMatch) {
    return normalized;
  }
  const drive = driveMatch[1].toLowerCase();
  const suffix = driveMatch[2].replace(/^\/+/, "");
  return `/mnt/${drive}/${suffix}`;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildDefaultMockResult(mode, payload) {
  if (mode === "triage") {
    return {
      normalizedTitle: payload.task.title,
      taskType: payload.task.taskType || "general",
      projectProfileId: payload.task.projectProfileId || "",
      placeId: payload.task.placeId || "",
      requiresStudio: Boolean(payload.task.projectProfileId),
      requiresManualVerification: Boolean(payload.task.projectProfileId),
      requiresClarification: !payload.task.projectProfileId,
      triageSummary: `Auto-triaged task ${payload.task.id} in mock mode.`,
      acceptanceCriteria: [
        "Operator confirms the task scope.",
        "Execution completes without worker errors."
      ],
      executorPrompt: payload.task.description || payload.task.title,
      questions: payload.task.projectProfileId ? [] : ["Which project profile should this task use?"],
      recommendedState: payload.task.projectProfileId ? "ready_for_execution" : "needs_clarification"
    };
  }

  if (mode === "chat") {
    return {
      responseMode: "chat_answer",
      assistantMessage: `Mock chat response for: ${payload.userMessage}`,
      finish: true,
      toolCalls: [],
      taskMutation: {
        action: "none",
        taskId: "",
        title: "",
        description: "",
        intentType: "general",
        visibility: "hidden",
        projectProfileId: "",
        placeId: "",
        taskType: "general",
        lastUserGoal: ""
      },
      executionProposal: {
        kind: "none",
        taskId: "",
        linearIdentifier: "",
        summary: "",
        projectProfileId: "",
        candidateTaskIds: []
      }
    };
  }

  return {
    summary: `Mock execution completed for ${payload.task.id}.`,
    outcomeStatus: "review",
    changedFiles: [],
    touchedSystems: ["mock-worker"],
    artifacts: [],
    followUpQuestions: [],
    blockedReason: "",
    recommendedState: "review"
  };
}

function runShellCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Worker command timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Worker command exited with ${code}.`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class CodexWorkerAdapter {
  constructor(options) {
    this.config = options.config;
    this.tempDir = options.tempDir;
    this.logger = options.logger || createLogger("codex");
  }

  async run(mode, payload) {
    if (this.config.runtime === "mock") {
      const delayMs = mode === "triage" ? this.config.mockMode.triageDelayMs : this.config.mockMode.executeDelayMs;
      await sleep(delayMs);
      return {
        runtime: "mock",
        raw: buildDefaultMockResult(mode, payload)
      };
    }

    if (this.config.runtime === "wsl") {
      return await this.runViaWsl(mode, payload);
    }

    if (this.config.runtime === "windows") {
      return await this.runViaWindowsCommand(mode, payload);
    }

    throw new Error(`Unsupported Codex runtime ${this.config.runtime}.`);
  }

  async writePayload(mode, payload) {
    const id = `${mode}-${randomUUID()}`;
    const inputPath = join(this.tempDir, `${id}.input.json`);
    const outputPath = join(this.tempDir, `${id}.output.json`);
    await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { inputPath, outputPath };
  }

  async runViaWsl(mode, payload) {
    const { inputPath, outputPath } = await this.writePayload(mode, payload);
    if (!normalizeText(this.config.wslCommand)) {
      throw new Error("Codex WSL runtime is selected, but codex.wslCommand is empty in .rbxmcp/automation/config.local.json.");
    }

    try {
      await runShellCommand("wsl.exe", ["--status"], {
        cwd: payload.workspacePath,
        env: process.env,
        timeoutMs: 5000
      });
    } catch {
      throw new Error("WSL is not installed or not available. Install WSL or switch codex.runtime to windows/mock.");
    }

    const wslInputPath = toWslPath(inputPath);
    const wslOutputPath = toWslPath(outputPath);
    const wslWorkspacePath = normalizeText(this.config.linuxWorkspaceRoot) || toWslPath(payload.workspacePath);
    const args = [];

    if (normalizeText(this.config.wslDistro)) {
      args.push("-d", this.config.wslDistro);
    }

    const command = [
      `RBXMCP_AUTOMATION_MODE=${shellEscape(mode)}`,
      `RBXMCP_AUTOMATION_INPUT_PATH=${shellEscape(wslInputPath)}`,
      `RBXMCP_AUTOMATION_OUTPUT_PATH=${shellEscape(wslOutputPath)}`,
      `RBXMCP_AUTOMATION_WORKSPACE=${shellEscape(wslWorkspacePath)}`,
      `RBXMCP_AUTOMATION_MODEL=${shellEscape(this.config.model || "")}`,
      `RBXMCP_AUTOMATION_REASONING_EFFORT=${shellEscape(this.config.reasoningEffort || "")}`,
      this.config.wslCommand
    ].join(" ");

    args.push("--", "sh", "-lc", command);

    await runShellCommand("wsl.exe", args, {
      cwd: payload.workspacePath,
      env: process.env,
      timeoutMs: this.config.timeoutMs
    });

    const text = await readFile(outputPath, "utf8");
    return {
      runtime: "wsl",
      raw: JSON.parse(text)
    };
  }

  async runViaWindowsCommand(mode, payload) {
    const { inputPath, outputPath } = await this.writePayload(mode, payload);
    if (!normalizeText(this.config.windowsCommand)) {
      throw new Error("Codex windows runtime is selected, but codex.windowsCommand is empty in .rbxmcp/automation/config.local.json.");
    }

    const env = {
      ...process.env,
      RBXMCP_AUTOMATION_MODE: mode,
      RBXMCP_AUTOMATION_INPUT_PATH: inputPath,
      RBXMCP_AUTOMATION_OUTPUT_PATH: outputPath,
      RBXMCP_AUTOMATION_WORKSPACE: payload.workspacePath,
      RBXMCP_AUTOMATION_MODEL: this.config.model || "",
      RBXMCP_AUTOMATION_REASONING_EFFORT: this.config.reasoningEffort || ""
    };

    await runShellCommand("cmd.exe", ["/d", "/s", "/c", this.config.windowsCommand], {
      cwd: payload.workspacePath,
      env,
      timeoutMs: this.config.timeoutMs
    });

    const text = await readFile(outputPath, "utf8");
    return {
      runtime: "windows",
      raw: JSON.parse(text)
    };
  }
}
