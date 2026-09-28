import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import type { BrowserContext } from "patchright";

process.env.ADS_DATA_DIR = mkdtempSync(join(tmpdir(), "ads-connect-"));
const { createEngine } = await import("./jobs.ts");
const { startMcpServer } = await import("./mcp.ts");
const { buildMcpb, connectChatGPT, daemonTools, isChatGPTConnected, isClaudeConnected } = await import("./connect.ts");

const tmp = () => mkdtempSync(join(tmpdir(), "ads-connect-"));
const APP = "/Applications/Ads Crosspost.app/Contents/MacOS/Ads Crosspost";

test("mcpb holds a manifest that runs the app with --stdio, tools from the daemon", async () => {
  const mcp = await startMcpServer({ engine: createEngine({ flows: {}, browsers: { get: async () => ({}) as BrowserContext }, pace: () => 0 }), port: 0 });
  after(() => mcp.close());
  const tools = await daemonTools(process.env.ADS_DATA_DIR!);
  assert.ok(tools.some((t) => t.name === "prepare_post" && t.description));

  const path = buildMcpb({ appExecutable: APP, outDir: tmp(), version: "1.2.3", tools });
  const files = unzipSync(readFileSync(path));
  assert.deepEqual(Object.keys(files), ["manifest.json"]);
  const m = JSON.parse(strFromU8(files["manifest.json"]));
  for (const k of ["manifest_version", "name", "version", "description", "author", "server"]) assert.ok(m[k], k);
  assert.equal(m.name, "ads-crosspost");
  assert.equal(m.version, "1.2.3");
  assert.ok(m.author.name);
  assert.deepEqual(m.server, { type: "binary", entry_point: APP, mcp_config: { command: APP, args: ["--stdio"] } });
  assert.deepEqual(m.compatibility.platforms, ["darwin", "win32"]);
  assert.deepEqual(m.tools, tools);
});

const read = (home: string) => readFileSync(join(home, ".codex", "config.toml"), "utf8");
const backups = (home: string) => readdirSync(join(home, ".codex")).filter((f) => f.startsWith("config.toml.bak-"));

test("codex: creates config in an empty home", () => {
  const home = tmp();
  assert.equal(isChatGPTConnected(home), false);
  const r = connectChatGPT({ home, appExecutable: APP });
  assert.equal(r.backup, undefined);
  assert.equal(read(home), `[mcp_servers.ads-crosspost]\ncommand = "${APP}"\nargs = ["--stdio"]\ntool_timeout_sec = 60\n`);
  assert.equal(isChatGPTConnected(home), true);
});

test("codex: keeps other servers and comments, backs up, replaces our table in place, idempotent", () => {
  const home = tmp();
  mkdirSync(join(home, ".codex"));
  const before = [
    '# my config',
    'model = "gpt-5"',
    '',
    '[mcp_servers.ads-crosspost]',
    'command = "/old/path"',
    'args = ["--stdio"]',
    '',
    '[mcp_servers.ads-crosspost.env]',
    'X = "1"',
    '',
    '# docs server',
    '[mcp_servers.context7]',
    'command = "npx" # inline',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
  ].join("\n");
  writeFileSync(join(home, ".codex", "config.toml"), before);

  const r = connectChatGPT({ home, appExecutable: "C:\\Program Files\\Ads\\Ads.exe", appArgs: ["/app"] });
  assert.equal(r.changed, true);
  assert.equal(readFileSync(r.backup!, "utf8"), before);
  assert.equal(read(home), [
    '# my config',
    'model = "gpt-5"',
    '',
    '[mcp_servers.ads-crosspost]',
    'command = "C:\\\\Program Files\\\\Ads\\\\Ads.exe"',
    'args = ["/app","--stdio"]',
    'tool_timeout_sec = 60',
    '',
    '# docs server',
    '[mcp_servers.context7]',
    'command = "npx" # inline',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
  ].join("\n"));

  const again = connectChatGPT({ home, appExecutable: "C:\\Program Files\\Ads\\Ads.exe", appArgs: ["/app"] });
  assert.equal(again.changed, false);
  assert.equal(backups(home).length, 1);
});

test("codex: appends after existing content", () => {
  const home = tmp();
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.ads-crosspost-other]\ncommand = "x"');
  assert.equal(isChatGPTConnected(home), false);
  connectChatGPT({ home, appExecutable: APP });
  assert.match(read(home), /^\[mcp_servers\.ads-crosspost-other\]\ncommand = "x"\n\n\[mcp_servers\.ads-crosspost\]\n/);
});

test("isClaudeConnected reads Claude Desktop's extension registry", () => {
  const home = tmp();
  assert.equal(isClaudeConnected(home, "darwin"), "unknown");
  const dir = join(home, "Library", "Application Support", "Claude");
  mkdirSync(join(dir, "Claude Extensions"), { recursive: true });
  assert.equal(isClaudeConnected(home, "darwin"), false);
  mkdirSync(join(dir, "Claude Extensions", "local.mcpb.ads-crosspost.ads-crosspost"));
  assert.equal(isClaudeConnected(home, "darwin"), true);
  writeFileSync(join(dir, "extensions-installations.json"), JSON.stringify({ extensions: { "local.mcpb.x.other": {} } }));
  assert.equal(isClaudeConnected(home, "darwin"), false);
  assert.equal(isClaudeConnected(home, "win32", { APPDATA: join(home, "Library", "Application Support") }), false);
});
