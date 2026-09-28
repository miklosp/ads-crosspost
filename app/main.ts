import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, shell, Tray, utilityProcess, type UtilityProcess } from "electron";
import { buildMcpb, connectChatGPT, daemonTools, isChatGPTConnected, isClaudeConnected } from "../src/connect.ts";
import { runShim } from "../src/shim.ts";

// Tray-resident shell. The engine (job queue, MCP server) runs in a utilityProcess; see docs/DESKTOP-APP.md.
// --stdio: MCP stdio shim for hosts (no lock, tray or windows); launches the tray app if the daemon is down.
const STDIO = process.argv.includes("--stdio");
if (STDIO) runShim({
  dataDir: app.getPath("userData"),
  launchApp: () => (process.platform === "darwin" && app.isPackaged
    ? spawn("open", ["-n", "-g", "-a", resolve(process.execPath, "../../..")], { detached: true, stdio: "ignore" })
    : spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { detached: true, stdio: "ignore" })).unref(),
}).then(() => app.exit(0));
else if (!app.requestSingleInstanceLock()) app.exit(0);

let tray: Tray;
let engine: UtilityProcess | undefined;
let status = "Engine starting…";
let quitting = false;
let browser: string | undefined; // Chromium status until it's ready, then the MCP address

function startEngine() {
  const data = app.getPath("userData");
  browser = undefined;
  engine = utilityProcess.fork(join(__dirname, "engine.mjs"), [], {
    serviceName: "Ads Crosspost Engine",
    env: { ...process.env, ADS_ROOT: app.getAppPath(), ADS_DATA_DIR: data, PLAYWRIGHT_BROWSERS_PATH: join(data, "browsers") },
  });
  engine.on("spawn", () => engine!.postMessage({ type: "ping" }));
  engine.on("message", (m) => {
    if (m?.type === "chromium") browser = chromiumStatus(m);
    if (m?.type === "mcp") browser = `Ready — MCP on ${new URL(m.url).host}`;
    if (m?.type === "pong" || m?.type === "chromium" || m?.type === "mcp") setStatus(browser ?? "Engine running");
  });
  engine.on("exit", (code) => {
    engine = undefined;
    if (quitting) return;
    setStatus(`Engine exited (${code}), restarting…`);
    setTimeout(startEngine, 1000);
  });
}

function chromiumStatus(m: { state: string; percent?: number; message?: string }): string | undefined {
  if (m.state === "checking") return "Checking Chromium…";
  if (m.state === "downloading") return `Downloading Chromium… ${m.percent}%`;
  if (m.state === "error") return m.message;
}

function setStatus(s: string) {
  status = s;
  tray.setToolTip(`Ads Crosspost — ${s}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: "separator" },
    { label: "Open window", click: openWindow },
    {
      label: "Launch at login", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    {
      label: "Connect", submenu: [
        { label: "Claude Desktop…", type: "checkbox", checked: isClaudeConnected(homedir()) === true, click: () => void connect(connectClaude) },
        { label: "ChatGPT desktop", type: "checkbox", checked: isChatGPTConnected(homedir()), click: () => void connect(connectChatGPTApp) },
      ],
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

// Host config command: the app binary; in dev the electron binary plus the app path (only works from this checkout).
const launch = { appExecutable: process.execPath, appArgs: app.isPackaged ? [] : [app.getAppPath()] };
const connect = (fn: () => Promise<void> | void) =>
  Promise.resolve().then(fn).catch((e) => dialog.showErrorBox("Connect failed", String(e))).finally(() => setStatus(status));
async function connectClaude() {
  const data = app.getPath("userData");
  const tools = await daemonTools(data).catch(() => undefined);
  const path = buildMcpb({ ...launch, outDir: data, version: app.getVersion(), tools });
  const err = await shell.openPath(path); // Claude Desktop shows its install dialog
  if (err) throw new Error(`${err}\nInstall ${path} from Claude Desktop → Settings → Extensions.`);
}
function connectChatGPTApp() {
  connectChatGPT({ home: homedir(), ...launch });
  dialog.showMessageBox({ message: "Connected to ChatGPT", detail: "Restart the ChatGPT app. The Ads Crosspost tools appear in Work (Codex) mode, not in Chat." });
}

let win: BrowserWindow | undefined;
function openWindow() {
  if (win) return win.show();
  win = new BrowserWindow({ width: 480, height: 320, title: "Ads Crosspost" });
  win.on("closed", () => (win = undefined));
  win.loadFile(join(__dirname, "../index.html"));
}

app.on("second-instance", openWindow);
app.on("window-all-closed", () => {}); // stay in the tray
app.on("before-quit", () => { quitting = true; engine?.kill(); });

app.whenReady().then(() => {
  if (STDIO) return;
  app.dock?.hide();
  tray = new Tray(join(__dirname, "../assets/trayTemplate.png"));
  setStatus(status);
  startEngine();
});
