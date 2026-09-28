// utilityProcess entry. Will host the job engine and MCP server from src/; for now answers pings and
// makes sure patchright's Chromium is in PLAYWRIGHT_BROWSERS_PATH (set by main to app data).
import { ensureChromium } from "../src/install.ts";

const port = process.parentPort;
const chromium = (m: object) => port.postMessage({ type: "chromium", ...m });

console.error("engine started");
port.on("message", (e) => { if (e.data?.type === "ping") port.postMessage({ type: "pong" }); });
setInterval(() => {}, 2 ** 31 - 1); // keep alive until the MCP server holds the event loop

chromium({ state: "checking" });
ensureChromium((percent) => chromium({ state: "downloading", percent })).then(
  () => chromium({ state: "ready" }),
  (e) => chromium({ state: "error", message: e.message }),
);
