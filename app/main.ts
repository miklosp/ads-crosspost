import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray, utilityProcess, type UtilityProcess } from "electron";
import { buildMcpb, connectChatGPT, daemonTools, isChatGPTConnected, isClaudeConnected } from "../src/connect.ts";
import { formatSummary, importData } from "../src/import.ts";
import type { Job } from "../src/jobs.ts";
import { runShim } from "../src/shim.ts";
import { attentionCount, notificationFor, PLATFORMS, type AppState } from "./attention.ts";

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
let lastError: string | undefined;
const jobs = new Map<string, Job>(); // latest known state of every job, relayed to the window
const seen = new Set<string>(); // id:state pairs already considered for a notification
const notes = new Set<Notification>(); // keep references so click handlers survive GC
const toEngine = (m: object) => engine?.postMessage(m);

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
    if (m?.type === "mcp") { browser = `Ready — MCP on ${new URL(m.url).host}`; toEngine({ type: "list" }); }
    if (m?.type === "jobs") { jobs.clear(); for (const j of m.jobs as Job[]) jobs.set(j.id, j); }
    if (m?.type === "job") { jobs.set(m.job.id, m.job); lastError = undefined; notify(m.job); }
    if (m?.type === "error") lastError = m.message;
    if (m?.type === "pong" || m?.type === "chromium" || m?.type === "mcp") setStatus(browser ?? "Engine running");
    if (m?.type === "jobs" || m?.type === "job" || m?.type === "error") setStatus(status);
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
  const attention = attentionCount(jobs.values());
  tray.setToolTip(`Ads Crosspost — ${s}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    ...(attention ? [{ label: `${attention} need${attention === 1 ? "s" : ""} attention`, click: () => openWindow() }] : []),
    { type: "separator" },
    { label: "Open window", click: () => openWindow() },
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
    { label: "Import from folder…", click: () => void importFolder() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  win?.webContents.send("state", appState());
}

const appState = (): AppState => ({ status, error: lastError, jobs: [...jobs.values()] });

function notify(job: Job) {
  const n = notificationFor(job, seen, !!win?.isFocused());
  if (!n || !Notification.isSupported()) return;
  const note = new Notification({ ...n, silent: false });
  notes.add(note);
  note.on("close", () => notes.delete(note));
  note.on("failed", (_e, err) => (notes.delete(note), console.error("notification failed:", err)));
  note.on("click", () => {
    notes.delete(note);
    if (job.state === "needs_login") toEngine({ type: "login", platform: job.platform });
    else openWindow(job.id);
  });
  note.show();
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

// Copies a CLI checkout's items/, sessions/ and config.yaml into userData (src/import.ts). The engine's browsers
// hold the profiles open, so they're closed first.
async function importFolder() {
  const pick = await dialog.showOpenDialog({ title: "Import from an ads-crosspost folder", properties: ["openDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return;
  const e = engine;
  if (e) await new Promise<void>((res) => {
    const done = (m: { type?: string }) => m?.type === "browsersClosed" && (e.off("message", done), res());
    e.on("message", done).once("exit", () => res());
    e.postMessage({ type: "closeBrowsers" });
  });
  try {
    const s = await importData(pick.filePaths[0], app.getPath("userData"));
    dialog.showMessageBox({ message: "Import finished", detail: formatSummary(s) });
  } catch (err) {
    dialog.showErrorBox("Import failed", err instanceof Error ? err.message : String(err));
  }
}

let win: BrowserWindow | undefined;
function openWindow(focusJob?: string) {
  const focus = () => focusJob && win?.webContents.send("focus-job", focusJob);
  if (win) return (win.show(), win.focus(), focus());
  win = new BrowserWindow({
    width: 560, height: 680, title: "Ads Crosspost",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on("closed", () => (win = undefined));
  win.webContents.once("did-finish-load", focus);
  win.loadFile(join(__dirname, "../index.html"));
}

// window → main; arguments are checked since they come from the renderer
ipcMain.handle("state", appState);
ipcMain.on("login", (_e, p) => PLATFORMS.includes(p) && toEngine({ type: "login", platform: p }));
ipcMain.on("publish", (_e, id) => jobs.has(id) && toEngine({ type: "publish", id }));
ipcMain.on("cancel", (_e, id) => jobs.has(id) && toEngine({ type: "cancel", id }));
ipcMain.on("open-url", (_e, url) => {
  if (/^https?:\/\//.test(url) && [...jobs.values()].some((j) => j.url === url)) void shell.openExternal(url);
});
ipcMain.handle("screenshot", async (_e, id) => {
  const file = jobs.get(id)?.screenshot;
  if (!file || !resolve(file).startsWith(app.getPath("userData") + sep)) return;
  const png = await readFile(file).catch(() => undefined);
  return png && `data:image/png;base64,${png.toString("base64")}`;
});

app.on("second-instance", () => openWindow());
app.on("window-all-closed", () => {}); // stay in the tray
app.on("before-quit", () => { quitting = true; engine?.kill(); });

app.whenReady().then(() => {
  if (STDIO) return;
  app.dock?.hide();
  tray = new Tray(join(__dirname, "../assets/trayTemplate.png"));
  setStatus(status);
  startEngine();
});
