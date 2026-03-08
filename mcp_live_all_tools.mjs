import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BRIDGE = "http://127.0.0.1:5100";
const TARGET_PATH = ["StarterGui", "RBXMCP_ApiSmoke_NoDelete"];

function printJson(label, value) {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
}

function parseToolPayload(result) {
  const textItem = Array.isArray(result?.content)
    ? result.content.find((item) => item && item.type === "text" && typeof item.text === "string")
    : null;
  if (!textItem) {
    return null;
  }
  try {
    return JSON.parse(textItem.text);
  } catch {
    return { rawText: textItem.text };
  }
}

async function callToolLogged(client, name, args) {
  printJson("=== MCP REQUEST ===", { method: "tools/call", params: { name, arguments: args } });
  try {
    const response = await client.callTool({ name, arguments: args });
    printJson("=== MCP RESPONSE ===", response);
    return parseToolPayload(response);
  } catch (error) {
    printJson("=== MCP RESPONSE ERROR ===", {
      name,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function httpJson(method, path, body) {
  const response = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { rawText: text };
  }
  return { status: response.status, json };
}

async function waitForStudioOnline(client, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await client.callTool({ name: "rbx_health", arguments: {} });
    const payload = parseToolPayload(result);
    if (payload?.studioOnline === true) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Studio plugin did not reconnect in time");
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./node_modules/tsx/dist/cli.mjs", "server/src/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      const text = String(chunk ?? "").trim();
      if (text.length > 0) {
        console.log("[server-stderr]", text);
      }
    });
  }

  const client = new Client({ name: "rbxmcp-live-api-audit", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  printJson("=== MCP REQUEST ===", { method: "tools/list", params: {} });
  printJson("=== MCP RESPONSE ===", tools);

  const onlineHealth = await waitForStudioOnline(client, 90_000);
  printJson("=== MCP INFO ===", { studioOnline: onlineHealth.studioOnline, session: onlineHealth.session });

  const upsertSeed = await httpJson("POST", "/v1/admin/upsert_script", {
    path: TARGET_PATH,
    className: "LocalScript",
    source: "print('rbxmcp api smoke seed')"
  });
  printJson("=== BRIDGE REQUEST ===", {
    method: "POST",
    url: `${BRIDGE}/v1/admin/upsert_script`,
    body: { path: TARGET_PATH, className: "LocalScript", source: "print('rbxmcp api smoke seed')" }
  });
  printJson("=== BRIDGE RESPONSE ===", upsertSeed);

  await callToolLogged(client, "rbx_health", {});
  await callToolLogged(client, "rbx_list_scripts", { limit: 10, query: "RBXMCP" });
  const getPayload = await callToolLogged(client, "rbx_get_script", { path: TARGET_PATH });
  const refreshPayload = await callToolLogged(client, "rbx_refresh_script", { path: TARGET_PATH });

  await callToolLogged(client, "rbx_search_text", { query: "rbxmcp api smoke", limit: 10 });
  await callToolLogged(client, "rbx_find_symbols", { name: "hello", limit: 20 });
  await callToolLogged(client, "rbx_find_references", { symbol: "require", limit: 20 });
  await callToolLogged(client, "rbx_get_context_bundle", {
    entryPaths: [TARGET_PATH],
    query: "print",
    budgetTokens: 600,
    dependencyDepth: 2
  });
  await callToolLogged(client, "rbx_get_script_range", { path: TARGET_PATH, startLine: 1, endLine: 20 });
  await callToolLogged(client, "rbx_get_dependencies", { path: TARGET_PATH, depth: 2 });
  await callToolLogged(client, "rbx_get_impact", { path: TARGET_PATH, depth: 2 });
  await callToolLogged(client, "rbx_refresh_scripts", { paths: [TARGET_PATH] });

  const expectedHash = refreshPayload?.hash ?? getPayload?.hash;
  const newSource = `print('rbxmcp api smoke update ${new Date().toISOString()}')`;
  if (typeof expectedHash === "string" && expectedHash.length > 0) {
    await callToolLogged(client, "rbx_update_script", {
      path: TARGET_PATH,
      expectedHash,
      newSource
    });
  } else {
    printJson("=== MCP INFO ===", {
      skipped: "rbx_update_script",
      reason: "expectedHash unavailable"
    });
  }

  await callToolLogged(client, "rbx_health", {});

  await client.close();
  await transport.close();
}

main().catch((error) => {
  printJson("=== FATAL ===", { message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
