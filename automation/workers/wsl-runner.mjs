import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}.`);
  }
  return value;
}

function schemaPathForMode(mode) {
  if (mode === "triage") {
    return join(here, "triage.schema.json");
  }
  if (mode === "execute") {
    return join(here, "execute.schema.json");
  }
  if (mode === "chat") {
    return join(here, "chat.schema.json");
  }
  throw new Error(`Unsupported automation mode ${mode}.`);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Command exited with ${code}.`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readErrorFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "turn.failed" && event.error?.message) {
      return event.error.message;
    }
    if (event.type === "error" && event.message) {
      return event.message;
    }
  }
  return "";
}

function readAssistantPayloadFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const candidates = [
      event?.last_agent_message,
      event?.assistant_message,
      event?.message,
      event?.content?.text,
      event?.text
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const text = candidate.trim();
      if (!text) {
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function main() {
  const mode = requiredEnv("RBXMCP_AUTOMATION_MODE");
  const inputPath = requiredEnv("RBXMCP_AUTOMATION_INPUT_PATH");
  const outputPath = requiredEnv("RBXMCP_AUTOMATION_OUTPUT_PATH");
  const workspace = requiredEnv("RBXMCP_AUTOMATION_WORKSPACE");
  const model = process.env.RBXMCP_AUTOMATION_MODEL || "";
  const reasoningEffort = process.env.RBXMCP_AUTOMATION_REASONING_EFFORT || "";
  const raw = await readFile(inputPath, "utf8");
  const payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const lastMessagePath = join("/tmp", `rbxmcp-${mode}-last-message.txt`);
  const schemaPath = schemaPathForMode(mode);

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--cd",
    workspace,
    "--json",
    "--sandbox",
    mode === "execute" ? "workspace-write" : "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    payload.prompt
  ];

  if (model) {
    args.splice(1, 0, "-m", model);
  }

  if (reasoningEffort) {
    args.splice(1, 0, "-c", `model_reasoning_effort=${reasoningEffort}`);
  }

  if (mode === "execute") {
    args.splice(1, 0, "--full-auto");
  }

  const { stdout } = await run("codex", args, {
    cwd: workspace,
    env: process.env
  });

  let parsed = null;
  let resultText = "";
  try {
    resultText = await readFile(lastMessagePath, "utf8");
  } catch {
    resultText = "";
  }

  if (resultText.trim()) {
    parsed = JSON.parse(resultText);
  } else {
    const events = parseJsonLines(stdout);
    const eventError = readErrorFromEvents(events);
    if (eventError) {
      throw new Error(eventError);
    }
    parsed = readAssistantPayloadFromEvents(events);
    if (!parsed) {
      throw new Error("Codex returned no assistant payload for chat worker.");
    }
  }

  await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

main().catch(async (error) => {
  const outputPath = process.env.RBXMCP_AUTOMATION_OUTPUT_PATH;
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }, null, 2)}\n`, "utf8").catch(() => {});
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
