import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium, type BrowserContext } from "patchright";
import { config } from "./config.ts";
import { DATA, type PlatformName } from "./record.ts";

// One persistent profile per platform; bundled Chromium, headed. See docs/BROWSER-AUTOMATION.md §2.
// config.window_display parks the window on a display you don't look at; see docs/BACKGROUND-APP.md.
export function openBrowser(p: PlatformName): Promise<BrowserContext> {
  const pos = config.window_display && displayOrigin(config.window_display);
  return chromium.launchPersistentContext(join(DATA, "sessions", p), {
    headless: false,
    viewport: null,
    args: pos ? [`--window-position=${pos}`] : [],
    slowMo: 300 + Math.random() * 500, // ms before every action (fixed per launch); per-step jitter is in flow.ts
  });
}

// Top-left of the named display in Chromium's coordinates (origin top-left of the main display, y down).
// NSScreen frames are bottom-left origin, y up, so flip against the main display's height.
function displayOrigin(name: string): string | undefined {
  if (process.platform !== "darwin") {
    console.warn("window_display is macOS-only — opening the window normally");
    return undefined;
  }
  const js = `ObjC.import("AppKit");
    const s = $.NSScreen.screens, mainH = s.objectAtIndex(0).frame.size.height;
    let out = "";
    for (let i = 0; i < s.count; i++) {
      const sc = s.objectAtIndex(i), f = sc.frame;
      if (sc.localizedName.js === ${JSON.stringify(name)}) out = f.origin.x + "," + (mainH - f.origin.y - f.size.height);
    }
    out;`;
  const out = execFileSync("osascript", ["-l", "JavaScript", "-e", js], { encoding: "utf8" }).trim();
  if (!out) console.warn(`display "${name}" not found (is SimpleDisplay running?) — opening the window normally`);
  return out || undefined;
}
