import { createServer } from "node:http";
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

async function main(): Promise<void> {
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

  const mcpServer = createMcpServer(bridge);
  await connectMcpStdio(mcpServer);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
