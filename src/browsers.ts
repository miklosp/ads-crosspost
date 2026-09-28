import type { BrowserContext } from "patchright";
import { openBrowser, showWindow } from "./browser.ts";
import { loadConfig, settings } from "./config.ts";
import type { PlatformName } from "./record.ts";

const IDLE_MS = 5 * 60_000;

// One persistent context per platform, reused across jobs so Chromium steals focus once per site rather than
// once per post (docs/BACKGROUND-APP.md). Jobs lease a platform while they hold a page; a context with no lease
// and no use for idleMs is closed if close_idle_browsers is on (read when the timer fires). A closed or crashed
// context is forgotten on its "close" event, so the next get() relaunches.
export function browserManager(
  launch: (p: PlatformName) => Promise<BrowserContext> = openBrowser,
  { idleMs = IDLE_MS, closeIdle = () => settings(loadConfig()).close_idle_browsers } = {},
) {
  const open = new Map<PlatformName, Promise<BrowserContext>>();
  const leases = new Map<PlatformName, number>();
  const timers = new Map<PlatformName, NodeJS.Timeout>();
  const unused = (p: PlatformName) => !leases.get(p);

  // (re)start p's idle timer, or stop it while p is leased or closed
  const touch = (p: PlatformName) => {
    clearTimeout(timers.get(p));
    timers.delete(p);
    if (open.has(p) && unused(p)) timers.set(p, setTimeout(() => closeIdle() && unused(p) && void close(p), idleMs).unref());
  };
  const forget = (p: PlatformName, c: Promise<BrowserContext>) => open.get(p) === c && (open.delete(p), touch(p));

  const get = (p: PlatformName): Promise<BrowserContext> => {
    const c: Promise<BrowserContext> = open.get(p) ?? launch(p).then(
      (ctx) => (ctx.on("close", () => forget(p, c)), ctx),
      (err) => (forget(p, c), Promise.reject(err)),
    );
    open.set(p, c);
    touch(p);
    return c;
  };

  // returns release(); safe to call more than once
  const lease = (p: PlatformName) => {
    leases.set(p, (leases.get(p) ?? 0) + 1);
    touch(p);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      leases.set(p, leases.get(p)! - 1);
      touch(p);
    };
  };

  const close = async (p: PlatformName) => {
    const c = open.get(p);
    open.delete(p);
    touch(p);
    await c?.then((ctx) => ctx.close(), () => {});
  };

  const closeAll = async () => void (await Promise.all([...open.keys()].map(close)));
  // closes p's context, or every context, unless a job holds a page in it
  const closeUnused = async (p?: PlatformName): Promise<void> => void (await Promise.all([...open.keys()].filter((q) => (p ?? q) === q && unused(q)).map(close)));

  return { get, lease, close, closeAll, closeUnused, reveal: showWindow };
}
