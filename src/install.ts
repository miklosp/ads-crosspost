import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "patchright";

// Installs patchright's Chromium into PLAYWRIGHT_BROWSERS_PATH (the desktop app points it at app data).
// Runs patchright's own CLI: its registry API only reports progress to stdout. Chromium only, no
// headless shell (we always run headed), never a branded Chrome.
export async function ensureChromium(onProgress?: (percent: number) => void): Promise<boolean> {
  if (existsSync(chromium.executablePath())) return false;
  await install(onProgress);
  if (!existsSync(chromium.executablePath())) throw new Error(`Chromium missing after install: ${chromium.executablePath()}`);
  return true;
}

function install(onProgress?: (percent: number) => void): Promise<void> {
  // ELECTRON_RUN_AS_NODE makes Electron's binary act as node; plain node ignores it.
  const cp = spawn(process.execPath, [cliPath(), "install", "--no-shell", "chromium"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const onData = (b: Buffer) => {
    out += b;
    for (const line of b.toString().split("\n")) {
      const p = parsePercent(line);
      if (p !== undefined) onProgress?.(p);
    }
  };
  cp.stdout.on("data", onData);
  cp.stderr.on("data", onData);
  return new Promise((resolve, reject) => {
    cp.on("error", reject);
    cp.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(installError(out, code)))));
  });
}

// Non-TTY progress lines look like "|■■■■■■■■        | 10% of 162.3 MiB".
export const parsePercent = (line: string) => {
  const m = /\|\s*(\d+)% of /.exec(line);
  return m ? Number(m[1]) : undefined;
};

export function installError(out: string, code: number | null): string {
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|getaddrinfo/.test(out))
    return "Chromium download failed: no internet connection. Will retry on next start.";
  return `Chromium install exited with ${code}: ${out.trim().split("\n").slice(-3).join(" ")}`;
}

// patchright is asarUnpack'ed; a child process can't run a script from inside app.asar.
export const unpacked = (p: string) => p.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");

function cliPath(): string {
  const req = typeof require === "function" ? require : createRequire(import.meta.url); // cjs bundle vs src
  return unpacked(join(dirname(req.resolve("patchright/package.json")), "cli.js"));
}
