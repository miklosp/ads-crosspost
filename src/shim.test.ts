import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserContext } from "patchright";

process.env.ADS_DATA_DIR = mkdtempSync(join(tmpdir(), "ads-shim-"));
const { createEngine } = await import("./jobs.ts");
const { startMcpServer } = await import("./mcp.ts");
const { appDataDir } = await import("./shim.ts");

const engine = createEngine({ flows: {}, browsers: { get: async () => ({}) as BrowserContext, lease: () => () => {}, closeUnused: async () => {}, reveal: async () => {} }, pace: () => 0 });
let mcp = await startMcpServer({ engine, port: 0 });
after(() => mcp.close());

const shim = async (dataDir: string) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "shim.ts")],
    env: { ...(process.env as Record<string, string>), ADS_DATA_DIR: dataDir },
    stderr: "ignore",
  }));
  return client;
};
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0].text;

test("appDataDir matches Electron userData", () => {
  assert.equal(appDataDir({ ADS_DATA_DIR: "/tmp/x" }, "darwin", "/h"), "/tmp/x");
  assert.equal(appDataDir({}, "darwin", "/h"), "/h/Library/Application Support/ads-crosspost");
  assert.equal(appDataDir({ APPDATA: "/h/AppData/Roaming" }, "win32", "/h"), "/h/AppData/Roaming/ads-crosspost");
  assert.equal(appDataDir({}, "linux", "/h"), "/h/.config/ads-crosspost");
  assert.equal(appDataDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/h"), "/x/ads-crosspost");
});

test("proxies tools/list and tools/call; reconnects after a daemon restart", async () => {
  const client = await shim(process.env.ADS_DATA_DIR!);
  assert.match(client.getInstructions() ?? "", /post_ad prompt/);
  assert.ok((await client.listTools()).tools.some((t) => t.name === "list_items"));
  let r = await client.callTool({ name: "list_items", arguments: {} });
  assert.ok(!r.isError);
  assert.deepEqual(JSON.parse(text(r)), []);

  await mcp.close();
  mcp = await startMcpServer({ engine, port: 0 }); // new port in mcp.json
  r = await client.callTool({ name: "list_jobs", arguments: {} });
  assert.ok(!r.isError, text(r));
  await client.close();
});

test("no daemon: tool call returns a clear error, shim keeps running", async () => {
  const client = await shim(mkdtempSync(join(tmpdir(), "ads-shim-none-")));
  for (let i = 0; i < 2; i++) {
    const r = await client.callTool({ name: "list_items", arguments: {} });
    assert.ok(r.isError);
    assert.match(text(r), /isn't running/);
  }
  await client.close();
});
