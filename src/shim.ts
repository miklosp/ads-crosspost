import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, CallToolResultSchema, GetPromptRequestSchema, GetPromptResultSchema, ListPromptsRequestSchema,
  ListPromptsResultSchema, ListToolsRequestSchema, ListToolsResultSchema, McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { INSTRUCTIONS } from "./instructions.ts";

// stdio ⇄ Streamable HTTP proxy for stdio-only MCP hosts (Claude Desktop .mcpb, Codex config). Reads the daemon's
// port and token from <dataDir>/mcp.json so host configs hold no secrets. Stdout carries protocol only.

const DOWN = "Ads Crosspost app isn't running — open it from Applications.";

// Electron's userData: <appData>/<app.name>, app.name = package.json productName ?? name. build.productName isn't
// copied into the packaged package.json, so this is `name`.
const APP_NAME = "ads-crosspost";
export const appDataDir = (env = process.env, platform = process.platform, home = homedir()) => {
  if (env.ADS_DATA_DIR) return resolve(env.ADS_DATA_DIR);
  const base = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA ?? join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, APP_NAME);
};

// MCP client to the running daemon; throws if it's down
export const daemonClient = async (dataDir: string) => {
  const conf = join(dataDir, "mcp.json");
  if (!existsSync(conf)) throw new Error("no mcp.json");
  const { port, token } = JSON.parse(readFileSync(conf, "utf8"));
  const c = new Client({ name: "ads-crosspost-shim", version: "0.1.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};

export async function runShim({ dataDir, launchApp }: { dataDir: string; launchApp?: () => void }) {
  let client: Client | undefined;
  let pending: Promise<Client> | undefined;

  const connect = () => daemonClient(dataDir);
  const connectOrLaunch = async () => {
    try {
      return await connect();
    } catch {}
    if (!launchApp) throw new Error(DOWN);
    launchApp();
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(500))
      try {
        return await connect();
      } catch {}
    throw new Error(DOWN);
  };
  const daemon = () => client ? Promise.resolve(client) : (pending ??= connectOrLaunch()
    .then((c) => (client = c))
    .finally(() => (pending = undefined)));

  // protocol errors from the daemon pass through; anything else (refused, 401 after a restart) reconnects once
  const forward = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(await daemon());
    } catch (e) {
      if (e instanceof McpError || !client) throw e;
      client = undefined;
      return fn(await daemon());
    }
  };

  const server = new Server({ name: "ads-crosspost", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, (req, { signal }) => forward((c) => c.request(req, ListToolsResultSchema, { signal })));
  server.setRequestHandler(CallToolRequestSchema, (req, { signal }) =>
    forward((c) => c.request(req, CallToolResultSchema, { signal })).catch((e) => {
      if (e instanceof McpError) throw e;
      return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
    }));
  server.setRequestHandler(ListPromptsRequestSchema, (req, { signal }) =>
    forward((c) => c.getServerCapabilities()?.prompts ? c.request(req, ListPromptsResultSchema, { signal }) : Promise.resolve({ prompts: [] })));
  server.setRequestHandler(GetPromptRequestSchema, (req, { signal }) => forward((c) => c.request(req, GetPromptResultSchema, { signal })));

  await server.connect(new StdioServerTransport());
  await new Promise((res) => process.stdin.once("end", res).once("close", res));
  await server.close();
}

if (import.meta.main) runShim({ dataDir: appDataDir() }).then(() => process.exit(0));
