import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeLogsDir } from "./paths.mjs";

function stamp() {
  return new Date().toISOString();
}

async function writeLogLine(line) {
  try {
    await mkdir(runtimeLogsDir, { recursive: true });
    await appendFile(join(runtimeLogsDir, "automation.log"), `${line}\n`, "utf8");
  } catch {
    // Logging must never break the runtime.
  }
}

export function createLogger(scope) {
  const prefix = `[automation:${scope}]`;
  function log(level, sink, message, meta) {
    const renderedMeta = meta === undefined || meta === "" ? "" : ` ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
    const line = `${stamp()} ${prefix} ${level.toUpperCase()} ${message}${renderedMeta}`;
    sink(line);
    void writeLogLine(line);
  }
  return {
    info(message, meta) {
      log("info", console.log, message, meta);
    },
    warn(message, meta) {
      log("warn", console.warn, message, meta);
    },
    error(message, meta) {
      log("error", console.error, message, meta);
    }
  };
}
