// Smoke test of the compiled app (out/, from `pnpm app:build`) under plain node, without Electron: starts the
// engine on a fresh data dir, talks MCP to it over HTTP and through the stdio shim. Downloads Chromium once into
// $PLAYWRIGHT_BROWSERS_PATH or .cache/smoke-browsers. Never opens a browser or contacts a marketplace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { claudeConfigEntry } from "../out/src/connect.js";

const repo = resolve(import.meta.dirname, "..");
const out = join(repo, "out");
const data = mkdtempSync(join(tmpdir(), "ads-smoke-"));
const env = {
  ...(process.env as Record<string, string>),
  ADS_DATA_DIR: data,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(repo, ".cache", "smoke-browsers"),
};

const engine = spawn(process.execPath, [join(out, "app", "engine.js")], { env, stdio: ["ignore", "inherit", "pipe"] });
const cleanup = async () => {
  if (engine.exitCode === null && engine.signalCode === null) await new Promise((r) => (engine.once("exit", r), engine.kill()));
  rmSync(data, { recursive: true, force: true });
};

async function main() {
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("engine: no mcp line within 180 s")), 180_000);
    let buf = "";
    engine.stderr.on("data", (b: Buffer) => {
      process.stderr.write(b);
      buf += b;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
        const m = (() => { try { return JSON.parse(buf.slice(0, i)); } catch {} })();
        if (m?.type === "chromium" && m.state === "error") rej(new Error(`engine: ${m.message}`));
        if (m?.type === "mcp") (clearTimeout(timer), res(m.url));
      }
    });
    engine.once("exit", (code) => rej(new Error(`engine exited (${code}) before serving MCP`)));
  });

  const { token } = JSON.parse(readFileSync(join(data, "mcp.json"), "utf8"));
  const http = new Client({ name: "smoke", version: "0" });
  await http.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = (await http.listTools()).tools.map((t) => t.name);
  for (const t of ["start_ad", "prepare_post", "publish", "search_categories"]) assert.ok(tools.includes(t), `http: tool ${t} missing`);
  assert.ok((await http.listPrompts()).prompts.some((p) => p.name === "post_ad"), "http: prompt post_ad missing");
  const r = await http.callTool({ name: "search_categories", arguments: { platform: "tradera", query: "cykel" } });
  const hits = JSON.parse((r.content as { text: string }[])[0].text) as string[];
  assert.ok(!r.isError && hits.length > 0, `search_categories: ${JSON.stringify(r.content)}`);
  console.log(`http ok: ${tools.length} tools, post_ad prompt, search_categories → ${hits.length} hits (${hits[0]})`);
  await http.close();

  // plain, then as hosts run it (the connect config; node stands in for the app binary, ELECTRON_RUN_AS_NODE is inert)
  const shim = join(out, "src", "shim.js");
  const host = claudeConfigEntry(process.execPath, shim);
  for (const [label, run] of [["shim", { command: process.execPath, args: [shim], env }], ["shim (host config)", { ...host, env: { ...env, ...host.env } }]] as const) {
    const stdio = new Client({ name: "smoke", version: "0" });
    await stdio.connect(new StdioClientTransport({ ...run, args: [...run.args], stderr: "inherit" }));
    const shimTools = (await stdio.listTools()).tools.map((t) => t.name);
    assert.deepEqual(shimTools, tools, `${label}: tools differ from the daemon's`);
    console.log(`${label} ok: ${shimTools.length} tools`);
    await stdio.close();
  }
}

try {
  await main();
  await cleanup();
  console.log("smoke ok");
} catch (e) {
  await cleanup();
  console.error(`smoke FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
