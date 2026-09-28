import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

// Claude Desktop's config dir; Cowork keeps files dropped into a task under local-agent-mode-sessions/**/uploads/.
export const claudeDir = (home: string, platform = process.platform, env = process.env) =>
  platform === "darwin" ? join(home, "Library", "Application Support", "Claude")
    : platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
    : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude");

export type Roots = { inbox: string; claude: string };
const CLOSE_MS = 5 * 60_000;

// Maps a path as the model sees it to a host path. Cowork runs tools in a VM: an attached folder is
// /sessions/<name>/mnt/<basename>/…, a file dropped into the chat is /sessions/<name>/mnt/uploads/<file>.
export function hostPath(p: string, { inbox, claude }: Roots): { path: string; note?: string } {
  if (!p.startsWith("/sessions/")) return { path: p };
  const m = p.match(/^\/sessions\/[^/]+\/mnt\/([^/]+)(?:\/(.*?))?\/?$/);
  if (m?.[1] === basename(inbox)) return { path: join(inbox, m[2] ?? "") };
  if (m?.[1] === "uploads" && m[2] && !m[2].includes("/")) return upload(m[2], join(claude, "local-agent-mode-sessions"));
  throw new Error(`${p} is inside the Cowork VM and not reachable from the host. Ask the user to attach the inbox folder ` +
    `(${inbox}) to this Cowork task, or to drop the photos into the chat, then pass the new paths as-is.`);
}

function upload(name: string, root: string): { path: string; note?: string } {
  const hits = (existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }) : [])
    .filter((e) => e.isFile() && e.name === name && basename(e.parentPath) === "uploads")
    .map((e) => ({ path: join(e.parentPath, e.name), mtime: statSync(join(e.parentPath, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!hits.length) throw new Error(`uploaded file ${name} not found under ${root}`);
  const close = hits.filter((h) => hits[0].mtime - h.mtime < CLOSE_MS).length;
  return { path: hits[0].path, note: close > 1 ? `${name}: ${close} uploads with this name within 5 minutes; used the newest (${hits[0].path})` : undefined };
}

// A file in the inbox (not already under imported/), whose original is moved away after import.
export const inInbox = (p: string, inbox: string) => {
  const r = relative(inbox, p);
  return !!r && !r.startsWith("..") && !r.startsWith(`imported${sep}`) && r !== "imported";
};
