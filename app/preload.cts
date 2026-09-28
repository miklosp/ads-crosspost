// Sandboxed preload: the window's only way to reach main. Must be CJS (.cts); may only require "electron".
import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "./attention.ts";

const api = {
  state: (): Promise<AppState> => ipcRenderer.invoke("state"),
  onState: (cb: (s: AppState) => void) => ipcRenderer.on("state", (_e, s: AppState) => cb(s)),
  onFocusJob: (cb: (id: string) => void) => ipcRenderer.on("focus-job", (_e, id: string) => cb(id)),
  login: (platform: string) => ipcRenderer.send("login", platform),
  publish: (id: string) => ipcRenderer.send("publish", id),
  cancel: (id: string) => ipcRenderer.send("cancel", id),
  screenshot: (id: string): Promise<string | undefined> => ipcRenderer.invoke("screenshot", id),
  openUrl: (url: string) => ipcRenderer.send("open-url", url),
  setSetting: (key: "close_idle_browsers" | "hide_browsers", value: boolean) => ipcRenderer.send("set-setting", key, value),
  chooseInbox: () => ipcRenderer.send("choose-inbox"),
  revealInbox: () => ipcRenderer.send("reveal-inbox"),
};
export type Api = typeof api;
contextBridge.exposeInMainWorld("api", api);
