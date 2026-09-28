import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { claudeDir } from "./photos-paths.ts";
import { ROOT } from "./record.ts";
import { daemonClient } from "./shim.ts";

// "Connect" for stdio-only hosts: both run the app binary (in dev the electron binary) as plain node on the compiled
// shim (src/shim.ts), so each host connection is a node process, not an Electron app with a Dock icon.

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
const ENV = { ELECTRON_RUN_AS_NODE: "1" };
export const mcpbManifest = ({ appExecutable, shim, version, tools }:
  { appExecutable: string; shim: string; version: string; tools?: Tool[] }) => ({
  manifest_version: "0.3",
  name: NAME,
  display_name: "Ads Crosspost",
  version,
  description: "Write second-hand ads and post them to Swedish marketplaces through the Ads Crosspost app.",
  author: { name: "Ads Crosspost" },
  server: { type: "binary", entry_point: appExecutable, mcp_config: { command: appExecutable, args: [shim], env: ENV } },
  ...(tools && { tools }),
  tools_generated: true,
  compatibility: { platforms: ["darwin", "win32"] },
});

export function buildMcpb(opts: { appExecutable: string; shim: string; outDir: string; version: string; tools?: Tool[] }) {
  const path = join(opts.outDir, `${NAME}.mcpb`);
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(path, zipSync({ "manifest.json": strToU8(JSON.stringify(mcpbManifest(opts), null, 2)) }));
  return path;
}

// Cowork plugin (Customize → Plugins → Upload): the same stdio shim as a local .mcp.json server, which Cowork
// binds into sessions more reliably than an .mcpb, plus the post_ad prompt as a skill. A frontmatter description
// with angle brackets fails upload validation (claude-code#63081).
const SKILL_DESCRIPTION = "Create a used-item ad and post it to Blocket, Tradera, Facebook Marketplace and Vinted with the Ads Crosspost tools. " +
  "Use when the user wants to sell something, says new item, post an ad, or next object.";
export function buildCoworkPlugin(opts: { appExecutable: string; shim: string; outDir: string; version: string }) {
  const path = join(opts.outDir, `${NAME}-cowork.zip`);
  const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2));
  const prompt = readFileSync(join(ROOT, "src", "prompts", "post_ad.md"), "utf8");
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(path, zipSync({
    ".claude-plugin/plugin.json": json({
      name: NAME, version: opts.version, author: { name: "Ads Crosspost" },
      description: "Write second-hand ads and post them to Swedish marketplaces through the Ads Crosspost app.",
    }),
    ".mcp.json": json({ mcpServers: { [NAME]: { command: opts.appExecutable, args: [opts.shim], env: ENV } } }),
    "skills/post-ad/SKILL.md": strToU8(`---\nname: post-ad\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${prompt}`),
  }));
  return path;
}

// Claude Desktop keeps installed extensions (id local.mcpb.<author>.<name>) in extensions-installations.json and
// "Claude Extensions/<id>/" under its config dir. Undocumented, so "unknown" when neither is readable.
export function isClaudeConnected(home: string, platform = process.platform, env = process.env): boolean | "unknown" {
  const dir = claudeDir(home, platform, env);
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
  if (existsSync(path)) copyFileSync(path, (backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true, backup };
}

export const isChatGPTConnected = (home: string) =>
  existsSync(codexConfig(home)) && readFileSync(codexConfig(home), "utf8").split("\n").some((l) => OURS.test(l));
