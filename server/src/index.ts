import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { CacheStore } from "./cache/cacheStore.js";
import { BridgeService } from "./bridge/bridgeService.js";
import { createBridgeHttpApp } from "./bridge/httpApi.js";
import { connectMcpStdio, createMcpServer } from "./mcp/server.js";

const BRIDGE_HOST = process.env.RBXMCP_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.RBXMCP_PORT ?? "5100");
const PROJECT_ALIAS = process.env.RBXMCP_PROJECT_ALIAS ?? "";
const EXPECT_PLACE_ID = process.env.RBXMCP_EXPECT_PLACE_ID ?? "";
const ENABLE_ADMIN_MUTATIONS = (process.env.RBXMCP_ENABLE_ADMIN_MUTATIONS ?? "").toLowerCase() === "true";
const DEFAULT_READ_MAX_AGE_MS = Number(process.env.RBXMCP_READ_MAX_AGE_MS ?? "5000");

export function shouldEnableMcpStdio(
  env: NodeJS.ProcessEnv = process.env,
  stdin: Pick<NodeJS.ReadStream, "isTTY"> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout
): boolean {
  const rawMode = (env.RBXMCP_STDIO_MODE ?? "auto").trim().toLowerCase();
  if (rawMode === "on" || rawMode === "true" || rawMode === "1") {
    return true;
  }
  if (rawMode === "off" || rawMode === "false" || rawMode === "0") {
    return false;
  }
  if (typeof env.RBXMCP_PORT === "string" && env.RBXMCP_PORT.trim().length > 0) {
    return false;
  }
  return !(stdin.isTTY === true || stdout.isTTY === true);
}

export async function main(): Promise<void> {
  const cache = new CacheStore(process.cwd());
  const bridge = new BridgeService(cache, {
    bridgeHost: BRIDGE_HOST,
    bridgePort: BRIDGE_PORT,
    projectAlias: PROJECT_ALIAS,
    expectedPlaceId: EXPECT_PLACE_ID,
    adminMutationsEnabled: ENABLE_ADMIN_MUTATIONS,
    defaultReadMaxAgeMs: Number.isFinite(DEFAULT_READ_MAX_AGE_MS) ? DEFAULT_READ_MAX_AGE_MS : 5000
  });
  await bridge.bootstrap();

  const app = createBridgeHttpApp(bridge);
  const httpServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(BRIDGE_PORT, BRIDGE_HOST, () => resolve());
  });

  if (shouldEnableMcpStdio()) {
    const mcpServer = createMcpServer(bridge);
    await connectMcpStdio(mcpServer);
  } else {
    process.stderr.write("RBXMCP: MCP stdio disabled for interactive terminal startup. Set RBXMCP_STDIO_MODE=on to force-enable it.\n");
  }
}

const isDirectEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isDirectEntry) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
