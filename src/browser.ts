import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { loadConfig, settings } from "./config.ts";
import { DATA, type PlatformName } from "./record.ts";

// One persistent profile per platform; bundled Chromium, headed. See docs/BROWSER-AUTOMATION.md §2.
// With hide_browsers on, config.window_display parks the window on a display you don't look at; see
// docs/BACKGROUND-APP.md. Config is read per launch so the app's Settings apply without a restart.
export function openBrowser(p: PlatformName): Promise<BrowserContext> {
  const config = loadConfig();
  const pos = settings(config).hide_browsers && config.window_display && displayOrigin(config.window_display);
  return chromium.launchPersistentContext(join(DATA, "sessions", p), {
    headless: false,
    viewport: null,
    args: pos ? [`--window-position=${pos}`] : [],
    slowMo: 300 + Math.random() * 500, // ms before every action (fixed per launch); per-step jitter is in flow.ts
  });
}

// Moves the page's window to the main display (e.g. a login window whose browser was launched hidden).
export async function showWindow(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }); // left/top need a normal window
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0 } });
  await cdp.detach();
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
