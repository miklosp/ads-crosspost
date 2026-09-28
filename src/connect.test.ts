import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectChatGPT, connectClaude, isChatGPTConnected, isClaudeConnected } from "./connect.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ads-connect-"));
const APP = "/Applications/Ads Crosspost.app/Contents/MacOS/Ads Crosspost";
const SHIM = "/Applications/Ads Crosspost.app/Contents/Resources/app.asar/out/src/shim.js";
const ENTRY = { command: APP, args: [SHIM], env: { ELECTRON_RUN_AS_NODE: "1" } };

const claudeJson = (dir: string) => join(dir, "claude_desktop_config.json");
const claudeBackups = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("claude_desktop_config.json.bak-"));

test("claude: creates config in a missing dir", () => {
  const dir = join(tmp(), "Claude");
  assert.equal(isClaudeConnected(dir), false);
  const r = connectClaude({ claudeDir: dir, appExecutable: APP, shim: SHIM });
  assert.deepEqual([r.changed, r.backup], [true, undefined]);
  assert.equal(readFileSync(claudeJson(dir), "utf8"), JSON.stringify({ mcpServers: { "ads-crosspost": ENTRY } }, null, 2) + "\n");
  assert.equal(isClaudeConnected(dir), true);
});

test("claude: keeps other servers and keys, backs up only on change, idempotent", () => {
  const dir = tmp();
  const before = JSON.stringify({ globalShortcut: "Cmd+Space", mcpServers: { other: { command: "npx", args: ["x"] }, "ads-crosspost": { command: "/old" } } });
  writeFileSync(claudeJson(dir), before);
  const r = connectClaude({ claudeDir: dir, appExecutable: APP, shim: SHIM });
  assert.equal(r.changed, true);
  assert.equal(readFileSync(r.backup!, "utf8"), before);
  assert.deepEqual(JSON.parse(readFileSync(claudeJson(dir), "utf8")),
    { globalShortcut: "Cmd+Space", mcpServers: { other: { command: "npx", args: ["x"] }, "ads-crosspost": ENTRY } });
  assert.equal(connectClaude({ claudeDir: dir, appExecutable: APP, shim: SHIM }).changed, false);
  assert.equal(claudeBackups(dir).length, 1);
});

test("claude: refuses invalid JSON and leaves it alone", () => {
  const dir = tmp();
  writeFileSync(claudeJson(dir), "{ nope");
  assert.throws(() => connectClaude({ claudeDir: dir, appExecutable: APP, shim: SHIM }), /not valid JSON/);
  assert.equal(readFileSync(claudeJson(dir), "utf8"), "{ nope");
  assert.deepEqual(claudeBackups(dir), []);
  assert.equal(isClaudeConnected(dir), false);
});

const read = (home: string) => readFileSync(join(home, ".codex", "config.toml"), "utf8");
const backups = (home: string) => readdirSync(join(home, ".codex")).filter((f) => f.startsWith("config.toml.bak-"));

test("codex: creates config in an empty home", () => {
  const home = tmp();
  assert.equal(isChatGPTConnected(home), false);
  const r = connectChatGPT({ home, appExecutable: APP, shim: SHIM });
  assert.equal(r.backup, undefined);
  assert.equal(read(home), `[mcp_servers.ads-crosspost]\ncommand = "${APP}"\nargs = ["${SHIM}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\ntool_timeout_sec = 60\n`);
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
    'args = ["/repo","--stdio"]',
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

  const win = { home, appExecutable: "C:\\Program Files\\Ads\\Ads.exe", shim: "C:\\Program Files\\Ads\\resources\\app.asar\\out\\src\\shim.js" };
  const r = connectChatGPT(win);
  assert.equal(r.changed, true);
  assert.equal(readFileSync(r.backup!, "utf8"), before);
  assert.equal(read(home), [
    '# my config',
    'model = "gpt-5"',
    '',
    '[mcp_servers.ads-crosspost]',
    'command = "C:\\\\Program Files\\\\Ads\\\\Ads.exe"',
    'args = ["C:\\\\Program Files\\\\Ads\\\\resources\\\\app.asar\\\\out\\\\src\\\\shim.js"]',
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    'tool_timeout_sec = 60',
    '',
    '# docs server',
    '[mcp_servers.context7]',
    'command = "npx" # inline',
    'args = ["-y", "@upstash/context7-mcp"]',
    '',
  ].join("\n"));

  const again = connectChatGPT(win);
  assert.equal(again.changed, false);
  assert.equal(backups(home).length, 1);
});

test("codex: appends after existing content", () => {
  const home = tmp();
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.ads-crosspost-other]\ncommand = "x"');
  assert.equal(isChatGPTConnected(home), false);
  connectChatGPT({ home, appExecutable: APP, shim: SHIM });
  assert.match(read(home), /^\[mcp_servers\.ads-crosspost-other\]\ncommand = "x"\n\n\[mcp_servers\.ads-crosspost\]\n/);
});
