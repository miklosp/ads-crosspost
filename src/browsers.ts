import type { BrowserContext } from "patchright";
import { openBrowser } from "./browser.ts";
import type { PlatformName } from "./record.ts";

// One persistent context per platform, kept open for the process lifetime so Chromium steals focus
// once per site rather than once per post (docs/BACKGROUND-APP.md). A closed or crashed context is
// forgotten on its "close" event, so the next get() relaunches.
export function browserManager(launch: (p: PlatformName) => Promise<BrowserContext> = openBrowser) {
  const open = new Map<PlatformName, Promise<BrowserContext>>();
  const forget = (p: PlatformName, c: Promise<BrowserContext>) => open.get(p) === c && open.delete(p);

  const get = (p: PlatformName): Promise<BrowserContext> => {
    const existing = open.get(p);
    if (existing) return existing;
    const c: Promise<BrowserContext> = launch(p).then(
      (ctx) => (ctx.on("close", () => forget(p, c)), ctx),
      (err) => (forget(p, c), Promise.reject(err)),
    );
    open.set(p, c);
    return c;
  };

  const close = async (p: PlatformName) => {
    const c = open.get(p);
    open.delete(p);
    await c?.then((ctx) => ctx.close(), () => {});
  };

  const closeAll = async () => void (await Promise.all([...open.keys()].map(close)));

  return { get, close, closeAll };
}
