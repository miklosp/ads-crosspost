import { constants, existsSync, lstatSync } from "node:fs";
import { cp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { appDataDir } from "./shim.ts";

// One-time copy of a CLI checkout's items/, sessions/ and config.yaml into the app's data dir, so logins carry
// over (same patchright Chromium build, so the sites see the same device). Only fs, so the tray's main process
// can run it; the engine's browsers must be closed first.

// Regenerable Chromium caches, relative to the profile dir (user-data-dir) and its per-profile subdirs
// (Default, Profile 1, …). Cookies, Local Storage, IndexedDB, Session Storage, Login Data etc. are kept.
const SKIP_ROOT = new Set(["GPUPersistentCache", "GraphiteDawnCache", "GrShaderCache", "ShaderCache", "component_crx_cache",
  "extensions_crx_cache", "Crashpad", "DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie", ".DS_Store"]);
const SKIP_PROFILE = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage"]);
export const skipped = (rel: string) => {
  const parts = rel.split(sep);
  return SKIP_ROOT.has(parts[0]) || parts[0].startsWith("BrowserMetrics") || SKIP_PROFILE.has(parts.slice(1).join("/"));
};

// Chromium holds a SingletonLock symlink (to "host-pid", a dangling target, hence lstat) while a profile is open
const locked = (profile: string) => {
  try {
    return lstatSync(join(profile, "SingletonLock")).isSymbolicLink();
  } catch {
    return false;
  }
};

const dirs = async (d: string) => existsSync(d) ? (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name) : [];
// clone on APFS/btrfs when possible, else a plain copy
const copy = (from: string, to: string, filter?: (src: string) => boolean) =>
  cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter });

export type ImportSummary = {
  items: { copied: string[]; skipped: string[] };
  sessions: { copied: string[]; skipped: string[]; refused: { platform: string; reason: string }[] };
  config: "copied" | "kept" | "absent";
};

export async function importData(fromDir: string, toDir: string, { overwrite = false } = {}): Promise<ImportSummary> {
  const from = resolve(fromDir), to = resolve(toDir);
  if (from === to) throw new Error(`${from} is already the data folder`);
  if (!existsSync(join(from, "items")) && !existsSync(join(from, "sessions")))
    throw new Error(`${from} has no items/ or sessions/ — pick the ads-crosspost checkout folder`);
  const s: ImportSummary = { items: { copied: [], skipped: [] }, sessions: { copied: [], skipped: [], refused: [] }, config: "absent" };

  for (const slug of await dirs(join(from, "items"))) {
    const dest = join(to, "items", slug);
    if (existsSync(dest)) s.items.skipped.push(slug);
    else await copy(join(from, "items", slug), dest).then(() => s.items.copied.push(slug));
  }

  for (const p of await dirs(join(from, "sessions"))) {
    const src = join(from, "sessions", p), dest = join(to, "sessions", p);
    const refuse = (reason: string) => s.sessions.refused.push({ platform: p, reason });
    if (locked(src)) refuse(`the ${p} browser profile is in use — close that Chromium window (or delete ${join(src, "SingletonLock")} if none is open)`);
    else if (locked(dest)) refuse(`the app's ${p} browser is open — close it first`);
    else if (existsSync(dest) && !overwrite) s.sessions.skipped.push(p);
    else {
      await rm(dest, { recursive: true, force: true });
      await copy(src, dest, (f) => !skipped(relative(src, f)));
      s.sessions.copied.push(p);
    }
  }

  if (!existsSync(join(from, "config.yaml"))) s.config = "absent";
  else if (existsSync(join(to, "config.yaml"))) s.config = "kept";
  else await copy(join(from, "config.yaml"), join(to, "config.yaml")).then(() => (s.config = "copied"));
  return s;
}

export const formatSummary = (s: ImportSummary) => [
  `Items: ${s.items.copied.length} copied${s.items.skipped.length ? `, skipped (already there): ${s.items.skipped.join(", ")}` : ""}`,
  `Logins: ${s.sessions.copied.join(", ") || "none"} copied${s.sessions.skipped.length ? `, kept the app's existing: ${s.sessions.skipped.join(", ")}` : ""}`,
  ...s.sessions.refused.map((r) => `Refused ${r.platform}: ${r.reason}`),
  `config.yaml: ${{ copied: "copied", kept: "kept the existing one", absent: "none to copy" }[s.config]}`,
].join("\n");

// pnpm import-data <fromDir> [--overwrite]; quit the tray app first
if (import.meta.main) {
  const args = process.argv.slice(2);
  const fromDir = args.find((a) => !a.startsWith("--"));
  if (!fromDir) {
    console.error("usage: pnpm import-data <checkout dir> [--overwrite]");
    process.exit(2);
  }
  const to = appDataDir();
  console.error(`Importing ${resolve(fromDir)} → ${to}`);
  importData(fromDir, to, { overwrite: args.includes("--overwrite") }).then(
    (s) => (console.error(formatSummary(s) + (s.sessions.skipped.length ? "\n(--overwrite replaces existing logins)" : "")), process.exit(s.sessions.refused.length ? 1 : 0)),
    (e) => (console.error(e instanceof Error ? e.message : e), process.exit(1)),
  );
}
