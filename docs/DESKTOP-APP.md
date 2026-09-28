# Desktop app: packaging and host connectivity

Researched 2026-09-28. Builds on [BACKGROUND-APP.md](BACKGROUND-APP.md) and [MCP-BIDI-RESEARCH.md](MCP-BIDI-RESEARCH.md).
"(unverified)" = no primary source or not tested.

## Decision summary

- **Build our own tray app; don't base it on Donut Browser or BrowserOS.**
  - Donut (Tauri, AGPL): its automation API, MCP tools and CDP `/run` all return HTTP 402 without a paid
    Donut cloud plan (`api_server.rs`, `cloud_auth.rs`). It ships only Wayfern, a Chromium build with
    no public source (unverified) and spoofed fingerprints. Borrow its patterns only: tray and
    single-instance setup, bundle targets, checksum-verified browser download.
  - BrowserOS (Chromium fork, AGPL): always exposes loopback CDP (9110 neo / 9100 classic) with
    `navigator.webdriver` patched false. That makes it a possible **fallback engine** via
    `connectOverCDP`, not a base. It means one shared profile and logging in again.
  - Nothing else fits (playwright-mcp, browser-use, steel, kernel are LLM-driven or server/cloud).
- **Stack: Electron + electron-builder.** TS only; Tray/Notification/login items/auto-update built in.
  - patchright runs in a `utilityProcess`.
  - `app/` and `src/` are compiled with `tsc` into `out/`, no bundler (`pnpm app:build`). `pnpm app:smoke` runs the compiled engine and stdio shim under plain node.
  - `patchright-core` and `sharp`/`@img` go in `asarUnpack`.
  - Tauri + Node sidecar saves ~50 MB but adds Rust. Size is dominated by the ~350 MB browser anyway.
- **Browser: not bundled.** Either keep patchright Chromium, downloaded on first run into app data via
  `PLAYWRIGHT_BROWSERS_PATH`, or use installed Google Chrome (`channel: "chrome"`, patchright's current
  recommendation). Switching from Chromium to Chrome changes the device the sites see, so it means
  logging in again.
- **Android: not feasible.** An APK can't drive a headed Chromium with its own profile. At most a remote UI.
- **Transport:** one daemon (the tray app) serving Streamable HTTP on `127.0.0.1:<port>/mcp`.
  - Security: a bearer token stored in a 0600 file, plus `Origin`/`Host` checks.
  - A stdio shim (`out/src/shim.js`) proxies stdio to the daemon and starts the app if it's down. Hosts run it
    with the app binary as plain node: `command` = app executable (dev: the electron binary), `args` = [shim path],
    `env` = `ELECTRON_RUN_AS_NODE=1`. So each host connection is a node process, not an Electron app with a
    Dock icon. Packaged, the shim loads from inside `app.asar` (tested on an unsigned `--dir` build); this relies
    on Electron's `runAsNode` fuse, which is on by default and electron-builder leaves alone unless
    `electronFuses` is set.
- **Long jobs:** tools return a `job_id` in under 5 s. `wait_for_status(job_id, max_s ≤ 45)` long-polls
  under Claude Desktop's ~60 s cap.
- **Needs attention:** OS notifications from the tray app. No host shows a server push in an idle chat,
  and Claude Desktop has no elicitation. The publish gate is server-side (`ready_to_publish` state).

## Hosts

| Host | Route | Notes |
|---|---|---|
| Claude Desktop (mac/win) | `.mcpb` stdio shim → daemon | No localhost HTTP; custom connectors need public HTTPS. ~60 s timeout. Images OK. No elicitation. |
| ChatGPT desktop (unified app) | `~/.codex/config.toml` entry (stdio or HTTP) | Tools reportedly hidden in Chat mode, work in Work/Codex mode ([codex#38162](https://github.com/openai/codex/issues/38162)). ChatGPT web needs public HTTPS, so skip it. |
| Gemini app / Spark | none | No local MCP. Gemini CLI (API-key users) and Antigravity have local MCP config. |
| Claude Code | `claude mcp add --transport http` | |
| Cursor / VS Code / LM Studio | deep links (`cursor://…/mcp/install`, `vscode:mcp/install`, `lmstudio://add_mcp`) | Cheap extras. |

Never expose the server through a public tunnel. It holds logged-in marketplace sessions, and page
content could inject prompts into a tool that can write.

## Hiding windows / focus

- **macOS:** virtual display (SimpleDisplay), as today. Launching Chromium activates it; there's no
  flag to prevent that ([playwright#41306](https://github.com/microsoft/playwright/issues/41306)).
  Keeping one browser per site open for the app's lifetime limits focus theft to startup.
  - Possible fix: `open -g --no-startup-window` + `connectOverCDP` + background `Target.createTarget`
    (godmode-bot PR #6). Whether patchright stealth survives that is unverified.
- **Windows:** negative `--window-position` may work (unverified). Playwright's defaults already
  disable occlusion throttling.
- **Linux:** Xvfb/Xephyr per browser on X11.

## Browser settings

The window's **Settings** section writes two keys to `config.yaml` in the data folder (comments and other
keys are kept). The engine reads them when it launches a browser, so no restart is needed.

- `close_idle_browsers` (default on): a site's browser closes after 5 minutes without a job. It is never
  closed while a job holds a page in it, e.g. a form waiting in `ready_to_publish`. The next job relaunches
  it, so focus is stolen again then.
- `hide_browsers` (default on when `window_display` is set): open browsers on `window_display`. Off means
  normal placement. Changing it closes idle browsers; ones in use keep their position until relaunched.
- A login job always moves its window to the main display (CDP `Browser.setWindowBounds`). Once the site
  reports logged in, that site's browser is closed, so the next job relaunches it hidden.

## Signing

- macOS: Developer ID + notarization, $99/yr. Without it the user allows the app in System Settings
  and electron-updater can't auto-update. Since Electron 42, macOS notifications (UNNotification)
  are only shown for signed apps; unsigned builds get a `failed` event, so the tray's "N need
  attention" line and the window are the only signals.
- Windows: Azure Artifact Signing is for individuals in the US/Canada only. From Sweden that means an
  org or an OV certificate. Unsigned builds get SmartScreen warnings.

## Importing a CLI checkout

`src/import.ts` copies a checkout's `items/`, `sessions/<platform>/` and `config.yaml` into the app's data
folder. The app runs the same patchright Chromium build, so the sites see the same device and the logins
keep working. Cookies can be copied because patchright launches Chromium with `--use-mock-keychain`.

- Tray → **Import from folder…** closes the engine's browsers, then imports.
- CLI: `pnpm import-data <checkout> [--overwrite]` imports into the app data folder (`ADS_DATA_DIR` is
  honoured). Quit the tray app first.
- Items whose slug already exists are skipped. A platform profile that already exists in the app is
  kept unless `--overwrite` is passed; the tray never overwrites.
- A profile with a `SingletonLock` (Chromium has it open) is refused, on either side.
- Regenerable caches are left out: `Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`,
  `DawnWebGPUCache`, `Service Worker/CacheStorage` in each profile, plus `GPUPersistentCache`,
  `GraphiteDawnCache`, `GrShaderCache`, `ShaderCache`, `component_crx_cache`, `extensions_crx_cache`,
  `Crashpad` and `BrowserMetrics*` at the top level. Cookies, Local Storage, IndexedDB and Session
  Storage are kept.
