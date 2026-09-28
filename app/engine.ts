// utilityProcess entry: makes sure patchright's Chromium is in PLAYWRIGHT_BROWSERS_PATH (set by main to app
// data), then runs the job engine and MCP server from src/. Under plain node (no parentPort) messages go to stderr.
import { browserManager } from "../src/browsers.ts";
import { ensureChromium } from "../src/install.ts";
import { createEngine } from "../src/jobs.ts";
import { startMcpServer } from "../src/mcp.ts";
import { FLOWS } from "../src/platforms/index.ts";

const port = process.parentPort as Electron.ParentPort | undefined;
const post = (m: object) => (port ? port.postMessage(m) : console.error(JSON.stringify(m)));
const chromium = (m: object) => post({ type: "chromium", ...m });
let engine: ReturnType<typeof createEngine> | undefined;
let browsers: ReturnType<typeof browserManager> | undefined;

console.error("engine started");
port?.on("message", ({ data: m }) => {
  const fail = (e: unknown) => post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  try {
    if (m?.type === "ping") post({ type: "pong" });
    else if (m?.type === "closeBrowsers") (browsers?.closeAll() ?? Promise.resolve()).catch(fail).finally(() => post({ type: "browsersClosed" }));
    else if (m?.type === "list") post({ type: "jobs", jobs: engine?.list() ?? [] });
    else if (!engine) throw new Error("engine not ready");
    else if (m.type === "login") engine.login(m.platform);
    else if (m.type === "publish") engine.publish(m.id);
    else if (m.type === "cancel") engine.cancel(m.id).catch(fail);
  } catch (e) {
    fail(e);
  }
});
setInterval(() => {}, 2 ** 31 - 1); // stay up (and don't respawn-loop) if Chromium setup fails

async function start() {
  browsers = browserManager();
  engine = createEngine({ flows: FLOWS, browsers });
  engine.on("change", (job) => post({ type: "job", job }));
  const mcp = await startMcpServer({ engine });
  process.once("SIGTERM", () => void Promise.all([browsers!.closeAll(), mcp.close()]).finally(() => process.exit(0)));
  post({ type: "mcp", url: mcp.url });
}

chromium({ state: "checking" });
ensureChromium((percent) => chromium({ state: "downloading", percent }))
  .then(() => (chromium({ state: "ready" }), start()))
  .catch((e) => chromium({ state: "error", message: e.message }));
