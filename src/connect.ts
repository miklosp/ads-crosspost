import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// "Connect" for stdio-only hosts: both run the app binary (in dev the electron binary) as plain node on the compiled
// shim (src/shim.ts), so each host connection is a node process, not an Electron app with a Dock icon.

const NAME = "ads-crosspost";
const ENV = { ELECTRON_RUN_AS_NODE: "1" };
const backupPath = (path: string) => `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;

// Claude Desktop (chat and Cowork) reads mcpServers from claude_desktop_config.json in its config dir (claudeDir).
export const claudeConfigEntry = (appExecutable: string, shim: string) => ({ command: appExecutable, args: [shim], env: ENV });
const claudeConfig = (dir: string) => join(dir, "claude_desktop_config.json");
const readClaudeConfig = (path: string) => {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON, left unchanged. Fix it and connect again.\n${e instanceof Error ? e.message : e}`);
  }
};

export function connectClaude({ claudeDir, appExecutable, shim }: { claudeDir: string; appExecutable: string; shim: string }) {
  const path = claudeConfig(claudeDir);
  const config = readClaudeConfig(path);
  const entry = claudeConfigEntry(appExecutable, shim);
  if (JSON.stringify(config.mcpServers?.[NAME]) === JSON.stringify(entry)) return { path, changed: false };
  let backup: string | undefined;
  if (existsSync(path)) copyFileSync(path, (backup = backupPath(path)));
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [NAME]: entry } }, null, 2) + "\n");
  return { path, changed: true, backup };
}

export function isClaudeConnected(claudeDir: string) {
  try {
    return !!readClaudeConfig(claudeConfig(claudeDir)).mcpServers?.[NAME];
  } catch {
    return false;
  }
}

// ChatGPT desktop (Work/Codex mode) shares Codex's ~/.codex/config.toml. JSON strings are valid TOML basic strings.
export const codexConfigEntry = (appExecutable: string, shim: string) =>
  `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(appExecutable)}\nargs = ${JSON.stringify([shim])}\n` +
  `env = { ${Object.entries(ENV).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }\ntool_timeout_sec = 60\n`;

const codexConfig = (home: string) => join(home, ".codex", "config.toml");
const OURS = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${NAME}"?\\s*(\\.[^\\]]*)?\\]`); // our table and its subtables
const HEADER = /^\s*\[/;

// Replace our table (and subtables) in place, or append it; everything else is kept byte for byte.
export function mergeCodexConfig(toml: string, entry: string) {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => OURS.test(l));
  if (start < 0) return (toml.trimEnd() ? `${toml.trimEnd()}\n\n` : "") + entry;
  let end = start + 1;
  while (end < lines.length && (!HEADER.test(lines[end]) || OURS.test(lines[end]))) end++;
  while (end > start + 1 && /^\s*(#|$)/.test(lines[end - 1])) end--; // comments/blanks before the next table stay
  return [...lines.slice(0, start), ...entry.trimEnd().split("\n"), ...lines.slice(end)].join("\n");
}

export function connectChatGPT({ home, appExecutable, shim }: { home: string; appExecutable: string; shim: string }) {
  const path = codexConfig(home);
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = mergeCodexConfig(old, codexConfigEntry(appExecutable, shim));
  if (next === old) return { path, changed: false };
  let backup: string | undefined;
  if (existsSync(path)) copyFileSync(path, (backup = backupPath(path)));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true, backup };
}

export const isChatGPTConnected = (home: string) =>
  existsSync(codexConfig(home)) && readFileSync(codexConfig(home), "utf8").split("\n").some((l) => OURS.test(l));
