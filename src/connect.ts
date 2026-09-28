import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { daemonClient } from "./shim.ts";

// "Connect" for stdio-only hosts: both launch the app binary with --stdio (src/shim.ts). appArgs goes before --stdio
// (in dev: the app path, since the executable is the bare electron binary).

const NAME = "ads-crosspost";
type Tool = { name: string; description?: string };

// Tools as the running daemon lists them, for the install dialog.
export async function daemonTools(dataDir: string): Promise<Tool[]> {
  const c = await daemonClient(dataDir);
  try {
    return (await c.listTools()).tools.map(({ name, description }) => ({ name, description }));
  } finally {
    await c.close();
  }
}

// MCPB manifest 0.3. server.type "binary" with an absolute command outside the bundle: the spec lets
// mcp_config.command be any command (hosts spawn it as given after ${__dirname} substitution), and a wrapper
// inside the bundle would lose its exec bit when Claude Desktop extracts it (mcpb#294). The bundle is manifest-only.
export const mcpbManifest = ({ appExecutable, appArgs = [], version, tools }:
  { appExecutable: string; appArgs?: string[]; version: string; tools?: Tool[] }) => ({
  manifest_version: "0.3",
  name: NAME,
  display_name: "Ads Crosspost",
  version,
  description: "Write second-hand ads and post them to Swedish marketplaces through the Ads Crosspost app.",
  author: { name: "Ads Crosspost" },
  server: { type: "binary", entry_point: appExecutable, mcp_config: { command: appExecutable, args: [...appArgs, "--stdio"] } },
  ...(tools && { tools }),
  tools_generated: true,
  compatibility: { platforms: ["darwin", "win32"] },
});

export function buildMcpb(opts: { appExecutable: string; appArgs?: string[]; outDir: string; version: string; tools?: Tool[] }) {
  const path = join(opts.outDir, `${NAME}.mcpb`);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(path, zipSync({ "manifest.json": strToU8(JSON.stringify(mcpbManifest(opts), null, 2)) }));
  return path;
}

// Claude Desktop keeps installed extensions (id local.mcpb.<author>.<name>) in extensions-installations.json and
// "Claude Extensions/<id>/" under its config dir. Undocumented, so "unknown" when neither is readable.
export function isClaudeConnected(home: string, platform = process.platform, env = process.env): boolean | "unknown" {
  const dir = platform === "darwin" ? join(home, "Library", "Application Support", "Claude")
    : platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");
  const ours = (id: string) => id === NAME || id.endsWith(`.${NAME}`);
  try {
    return Object.keys(JSON.parse(readFileSync(join(dir, "extensions-installations.json"), "utf8")).extensions ?? {}).some(ours);
  } catch {}
  try {
    return readdirSync(join(dir, "Claude Extensions")).some(ours);
  } catch {}
  return "unknown";
}

// ChatGPT desktop (Work/Codex mode) shares Codex's ~/.codex/config.toml. JSON strings are valid TOML basic strings.
export const codexConfigEntry = (appExecutable: string, appArgs: string[] = []) =>
  `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(appExecutable)}\nargs = ${JSON.stringify([...appArgs, "--stdio"])}\ntool_timeout_sec = 60\n`;

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

export function connectChatGPT({ home, appExecutable, appArgs }: { home: string; appExecutable: string; appArgs?: string[] }) {
  const path = codexConfig(home);
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = mergeCodexConfig(old, codexConfigEntry(appExecutable, appArgs));
  if (next === old) return { path, changed: false };
  let backup: string | undefined;
  if (existsSync(path)) copyFileSync(path, (backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true, backup };
}

export const isChatGPTConnected = (home: string) =>
  existsSync(codexConfig(home)) && readFileSync(codexConfig(home), "utf8").split("\n").some((l) => OURS.test(l));
