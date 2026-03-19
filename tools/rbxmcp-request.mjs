#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import process from "node:process";

function printUsage() {
  process.stderr.write(
    "Usage: node tools/rbxmcp-request.mjs --endpoint /v1/agent/health [--method POST] [--host 127.0.0.1] [--port 5111] [--file payload.json | --stdin]\n"
  );
}

function parseArgs(argv) {
  const options = {
    endpoint: "",
    method: "POST",
    host: "127.0.0.1",
    port: Number(process.env.RBXMCP_PORT ?? "5100"),
    file: "",
    stdin: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--endpoint") {
      options.endpoint = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--method") {
      options.method = (argv[index + 1] ?? "POST").toUpperCase();
      index += 1;
      continue;
    }
    if (arg === "--host") {
      options.host = argv[index + 1] ?? "127.0.0.1";
      index += 1;
      continue;
    }
    if (arg === "--port") {
      options.port = Number(argv[index + 1] ?? options.port);
      index += 1;
      continue;
    }
    if (arg === "--file") {
      options.file = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--stdin") {
      options.stdin = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.endpoint) {
    throw new Error("--endpoint is required");
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive number");
  }
  if (options.file && options.stdin) {
    throw new Error("Use either --file or --stdin, not both");
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function requestJson({ method, host, port, endpoint, body }) {
  return await new Promise((resolve, reject) => {
    const headers = {};
    if (body && body.length > 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(body.length);
    }

    const req = http.request(
      {
        method,
        host,
        port,
        path: endpoint.startsWith("/") ? endpoint : `/${endpoint}`,
        headers
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    req.setTimeout(30_000, () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let body = Buffer.alloc(0);

  if (options.file) {
    body = await fs.readFile(options.file);
  } else if (options.stdin) {
    body = await readStdin();
  } else if (options.method !== "GET") {
    throw new Error("Provide --file or --stdin for non-GET requests");
  }

  const response = await requestJson({
    method: options.method,
    host: options.host,
    port: options.port,
    endpoint: options.endpoint,
    body
  });

  if (response.body) {
    process.stdout.write(response.body);
    if (!response.body.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
