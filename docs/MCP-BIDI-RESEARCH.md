# ads-crosspost as a Claude Desktop MCP app, on Gecko/WebDriver BiDi?

Researched 2026-09-26. Read-only: nothing in the repo was changed, nothing was run against the marketplaces.
"(unverified)" means I found no primary source or did not test it.

## TL;DR

1. **Split the two ideas.** "MCP server for Claude Desktop" and "switch to Firefox/BiDi" are independent. The MCP part is mostly plumbing around the existing `runPost()`. The Firefox part is a browser swap with real anti-bot risk and no clear upside for this tool.
2. **Gecko via Playwright is technically feasible with almost no flow changes.** Playwright has an undocumented, experimental `moz-firefox` channel that drives stock Firefox over WebDriver BiDi. Every API the four flows use (role/label locators, shadow-DOM piercing, `setInputFiles`, `waitForResponse`, `ariaSnapshot`, `evaluate`, screenshots, persistent context) goes through Playwright's own injected JS or through BiDi commands that Firefox implements. The catch is that it is experimental: the Firefox-nightly BiDi expectations list ~370 non-passing tests.
3. **Gecko+BiDi is *more* detectable than patchright in one concrete way.** Firefox sets `navigator.webdriver = true` whenever the Remote Agent runs (`--remote-debugging-port`, which Playwright always passes). There is no pref to turn it off. Patchright hides this on Chromium. Switching engines also makes every account look like it moved to a new device.
4. **Photos dropped into a Claude Desktop chat do not reach a local MCP server.** The model sees them, but a tool cannot receive the bytes. You need either a folder path, or an MCP App (UI panel) with a drop zone that calls an app-only tool.
5. **Claude Desktop cancels stdio tool calls at about 60 s** (reported, closed "not planned"). A post takes minutes, so posting must be an async job with a status poll. The browser stays open between calls.
6. **Recommendation:** ship the MCP server on the current patchright/Chromium stack first (phases 1–3 below). Treat Firefox as a separate per-platform experiment, run only if Vinted or Facebook start checkpointing Chromium. Keep it personal. Distributing it to others changes the risk profile a lot (§6).

---

## 1. WebDriver BiDi in 2026: what works with Firefox

### Firefox itself
- BiDi is Firefox's only remote protocol. CDP was removed, and Mozilla's work is organised in milestones. M20 finished 2026-06-28 and M21 is in progress. M17 added response bodies (`network.getData`), M12 network interception, M15 user-context config, and M19 targeted "experimental WebDriver BiDi support in Playwright" ([MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)).
- `input.setFiles` exists and sets files on `<input type=file>` without a picker ([MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/setFiles)).
- `network.getData` has had open bugs on edge cases: empty bodies ([bug 1986025](https://bugzilla.mozilla.org/show_bug.cgi?id=1986025)) and a RangeError on specific bodies ([bug 2004973](https://bugzilla.mozilla.org/show_bug.cgi?id=2004973)).

### Library by library

| Library | Firefox transport | Fit for these flows |
|---|---|---|
| **Playwright `firefox` (default)** | **Juggler**, a Playwright-patched Firefox build (currently Firefox 156, `browsers.json` rev 1551). Docs: "Playwright doesn't work with the branded version of Firefox since it relies on patches" ([browsers.md](https://github.com/microsoft/playwright/blob/main/docs/src/browsers.md)) | Mature, full API. **Not BiDi.** It is a custom Firefox build, not the user's Firefox. |
| **Playwright `channel: "moz-firefox"` / `-beta` / `-nightly`** | **WebDriver BiDi** against stock Firefox at `/Applications/Firefox.app` (mac) or `\Mozilla Firefox\firefox.exe` (win) ([registry/index.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/index.ts)). Undocumented, but present in v1.63 (2026-09-04), in CI (`tests_bidi.yml` runs `moz-firefox-nightly`), and in Playwright MCP's config | Same Playwright API, so the flows port nearly unchanged. Experimental: `tests/bidi/expectations/moz-firefox-nightly-{page,library}.txt` (updated 2026-09-25) list 241 fail + 121 timeout + 10 flaky. The 2024 blocker list is in [playwright#32577](https://github.com/microsoft/playwright/issues/32577) and [w3c/webdriver-bidi#769](https://github.com/w3c/webdriver-bidi/issues/769). |
| **patchright** | Chromium only ([patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)); no Firefox | If you go to Firefox, you lose patchright and use plain `playwright`. |
| **Puppeteer (v25)** | BiDi by default for Firefox | Poor fit. Unsupported on BiDi: **ARIA selectors / accessibility**, **`HTTPResponse.buffer/text/content`**. `uploadFile`, `evaluate`, screenshots (`clip`/`fullPage` only), cookies and request interception work ([pptr.dev/webdriver-bidi](https://pptr.dev/webdriver-bidi), [doc source](https://github.com/puppeteer/puppeteer/blob/main/docs/webdriver-bidi.md)). All four flows are `getByRole`-based, so this is a rewrite. |
| **WebdriverIO v9** | BiDi on by default; auto-pierces shadow roots ([v9 release](https://webdriver.io/blog/2024/08/15/webdriverio-v9-release/)) | `aria/` selectors are being moved to BiDi `browsingContext.locateNodes` accessibility locators, and that PR was blocked on a shadow-DOM regression ([wdio#15615](https://github.com/webdriverio/webdriverio/pull/15615)). Deep-selector bugs are open ([#14512](https://github.com/webdriverio/webdriverio/issues/14512)). A different API, so a full rewrite. |
| **Selenium 4 BiDi** | BiDi network/log/script modules ([docs](https://www.selenium.dev/documentation/webdriver/bidi/network/)); request/response body retrieval was still a feature request ([selenium#16514](https://github.com/SeleniumHQ/selenium/issues/16514)) | No role locators. Full rewrite. Not worth it. |

### What the flows need, checked against Playwright `moz-firefox`

I read Playwright's BiDi backend (`packages/playwright-core/src/server/bidi/*`) and the Firefox-nightly failure list.

| Need (where in repo) | Mechanism under BiDi | Status |
|---|---|---|
| Persistent profile (`browser.ts`) | `launchPersistentContext` passes `--profile <dir>` and writes a **`user.js` of test prefs** into it (`bidiFirefox.ts` → `firefoxPrefs.ts`) | Works. One `defaultbrowsercontext-2 › should work in persistent context` test fails, plus the colorScheme/hasTouch/reducedMotion options (not used here). See §2 for why the `user.js` matters. |
| `setInputFiles` (all 4 flows) | `input.setFiles` (`bidiPage.ts:680`) | Works. Only "should upload a folder" fails. |
| Shadow DOM (Blocket `w-select`/`w-textfield`) | Playwright's injected selector engine pierces open shadow roots in JS, independent of protocol | Should work (unverified on Blocket). |
| `getByRole`/`getByLabel`/`ariaSnapshot` (all flows, `flow.ts:88`) | Computed by Playwright's injected script, not by a protocol accessibility API. This is why Playwright keeps role locators on BiDi while Puppeteer loses them. | Works. Only `aria-invalid` a11y-tree and one iframe aria-snapshot test (flaky) are in the fail list. |
| `waitForResponse` (Vinted `/api/v2/photos`) | `network.responseCompleted` events | Works. Nothing matching in the fail list. |
| Response body `r.text()` (`discover.ts:220`, Facebook GraphQL) | `network.getData` (`bidiNetworkManager.ts:131`) | Works, with the Firefox bugs above. Request **post-data** tests fail (not used here). |
| `page.evaluate(fetch…)` (`discover.ts`) | `script.callFunction` | Works. |
| Screenshots (`flow.ts`) | `browsingContext.captureScreenshot` | `fullPage` works. Some scale/transparency cases fail (not used here). |
| `slowMo` (`browser.ts`) | client-side | Two frame check/uncheck slowMo tests fail. Cosmetic. |

**Verdict:** on Playwright's `moz-firefox` channel, the flows and `flow.ts` need an import change and a new `browser.ts`, and that is all. It is still an experimental channel on a moving Firefox, so expect Playwright-level breakage that you cannot repair from the flow files.

## 2. Anti-bot: Gecko+BiDi vs patchright Chromium

- **`navigator.webdriver` is true under BiDi.** Firefox sets it whenever the Remote Agent is enabled via `--remote-debugging-port`, since Firefox 101 ([bug 1719505](https://bugzilla.mozilla.org/show_bug.cgi?id=1719505)), bound to the session lifetime ([bug 1696425](https://bugzilla.mozilla.org/show_bug.cgi?id=1696425)). Playwright's `moz-firefox` launcher always passes `--remote-debugging-port=0`. I found no pref that disables it. Overriding it with an init script is itself detectable (property descriptor/prototype checks). Patchright on Chromium does not set the flag and removes the `Runtime.enable` leak. **For DataDome (Vinted) this is a regression**, even though DataDome treats the flag as one signal among many ([DataDome](https://datadome.co/threat-research/how-browser-vendors-are-quietly-making-automation-harder-to-detect/)).
- **Juggler (Playwright's patched Firefox)** is not CDP and has no `Runtime.enable` tell. Camoufox says it had to patch Juggler to hide `navigator.webdriver` and Playwright's page-visible helpers, which implies stock Juggler exposes them (unverified directly) ([Camoufox](https://github.com/daijro/camoufox)). Camoufox also had a year-long maintenance gap and has "gone down in performance" ([ScrapingBee 2026](https://www.scrapingbee.com/blog/how-to-scrape-with-camoufox-to-bypass-antibot-technology/)).
- **Firefox advantages that are real:** no CDP surface at all, and a TLS/JA3 fingerprint of a real Firefox. Scraping benchmarks show Camoufox (not stock Firefox) beating Chromium tools on Cloudflare, and "bypassed with workarounds" on one DataDome site ([TWSC wiki](https://publish.obsidian.md/twsc-public/Web+Scraping/Wiki/comparisons/firefox-vs-chrome-stealth), secondary). Those numbers are for fresh-identity scraping, not logged-in posting.
- **Patchright is not magic either.** It is still detectable by DataDome "in certain configurations", mostly headless ([scrapewise 2026](https://scrapewise.ai/blogs/playwright-stealth-2026), secondary). The repo already runs headed and at human pace, which is the configuration that matters.
- **Account continuity matters more than the engine.** All four sessions in `sessions/<p>/` are Chromium profiles. A switch means re-logging into every site from a "new Firefox device". Facebook and Vinted key on device/session history (unverified, forum lore). BROWSER-AUTOMATION.md §2 already rejected Camoufox for this reason.
- **Using the user's real daily Firefox profile: don't.**
  1. Playwright's `prepareUserDataDir` writes `user.js` into the profile. It permanently turns off safe browsing, tracking protection, the popup blocker and SameSite-lax-by-default, and turns on `dom.testing.testutils.enabled` (`firefoxPrefs.ts`). It changes the user's everyday browser and may itself be a tell (unverified).
  2. Firefox locks a profile per process, so the user's Firefox must be closed during every post.
  3. BiDi then drives the profile with every logged-in site in it, which widens the blast radius of a bug.

  A dedicated profile per platform (as today) remains the right shape.
- **Bottom line:** no evidence that Gecko+BiDi is stealthier than headed patchright Chromium for logged-in, low-volume posting, and one concrete signal (`navigator.webdriver`) says it is worse. Cadence and volume remain the main Vinted trigger ([Redrip](https://www.redrip.app/en/blog/vinted-automation-restriction-2026/), secondary).

## 3. MCP server design for Claude Desktop

### Transport and packaging
- Local server over **stdio**, packaged as an **MCP Bundle (`.mcpb`)**: a zip with `manifest.json` plus the server. Install by double-click, drag into Claude Desktop, or Settings → Extensions → Install Extension ([Claude docs: MCPB](https://claude.com/docs/connectors/building/mcpb), [mcpb repo](https://github.com/modelcontextprotocol/mcpb)). `.mcpb` replaced `.dxt` in late 2025, and both still install.
- `server.type: "node"` is recommended because Claude Desktop ships Node on macOS and Windows. Manifest `0.3`/`0.4` fields: `compatibility.platforms` (`darwin`, `win32`), `user_config` with `directory`/`file` pickers and `sensitive` strings, variables `${__dirname}`, `${HOME}`, `${DOCUMENTS}`, `${DOWNLOADS}`, and `platform_overrides` ([MANIFEST.md](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)). `mcpb sign` / `verify` / `--self-signed` exist ([CLI.md](https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md)).
- **The directory no longer accepts `.mcpb` submissions.** Public distribution goes through a *plugin*. Otherwise users install the file by hand (same docs page).

### Photos: the hard constraint
- Images attached in a Claude Desktop chat reach the **model** (vision) but **not MCP tools**. There is no way to pass the uploaded bytes into a tool argument ([python-sdk#499](https://github.com/modelcontextprotocol/python-sdk/issues/499)). Having the model re-emit base64 is not viable (token cost, truncation).
- Workable options, in order of simplicity:
  1. **Folder path.** The user drops photos into a folder (or a `user_config` "Inbox" directory) and says which one. Tool `add_photos(slug, folder | paths[])` copies them into `items/<slug>/photos/` and **returns downscaled thumbnails as `image` content blocks**, so Claude sees the actual photos when writing the ad. No chat attachment is needed.
  2. **MCP App drop zone.** MCP Apps (live in Claude/Claude Desktop since 2026-01-26, [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)) let a tool return a sandboxed HTML UI. The UI can call server tools marked `_meta.ui.visibility: ["app"]`, which are hidden from the model ([spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). A drop zone with `<input type=file>` then calls `upload_photo(slug, name, base64)` per file. The sandbox has `allow-scripts allow-same-origin`. Whether file pickers and drag-drop work inside Claude Desktop's double iframe is **unverified**. The same app can show the review/confirm screen.
- `photos.ts` (sharp resize, EXIF strip) is unchanged either way.

### Tool calls longer than 60 s
- Claude Desktop cancels stdio tool calls at about 60 s and ignores `MCP_TOOL_TIMEOUT` and progress notifications. Reported on build 1.9659.1 (2026-05-28), closed "not planned" ([claude-code#63379](https://github.com/anthropics/claude-code/issues/63379)). A separate report describes a ~4 min cap on Windows ([#44032](https://claudeissues.com/issue/44032-bug-claude-desktop-mcp-tool-calls-silently-timeout-after-4min-on-windows-affects)). A single flow run with photo uploads takes 1–3 min.
- Design consequence: **every browser action is a background job** in the long-lived stdio process, and tools return immediately with a `job_id`.

### Proposed tool surface

| Tool | Kind | Notes |
|---|---|---|
| `create_item(fields)` | write record | zod-validated, same `RecordSchema`; returns slug |
| `add_photos(slug, folder\|paths)` | write | returns thumbnails as image content |
| `update_item(slug, patch)` | write | the only way the model edits a record (keeps `record.ts` the single writer) |
| `search_categories(platform, query)` | read | `rg` over `<p>.categories.json`; never return whole files |
| `get_category_fields(platform, path)` | read | `categories[path]` joined with `fields[key]` from `<p>.fields.json`; truncate huge option lists (brand lists) behind a `search_options(platform, field, query)` |
| `login(platform)` | job | opens headed window on `sessions/<p>`, resolves when the user closes it or a logged-in marker appears |
| `prepare_post(slug, platform)` | job | runs every step up to (not incl.) `submit`, keeps the page open, stores the screenshot. This is today's `--dry-run`, minus the close. |
| `get_status(job_id)` | read | state + current step; on `ready_to_publish` returns the filled-form screenshot as an image; on failure returns `error.txt` + a trimmed `aria.txt` |
| `publish(job_id)` | job, destructive | clicks `submit` → `capture_url` on the *already filled* page; `annotations.destructiveHint: true` |
| `cancel(job_id)` | write | closes browser, draft abandoned |
| `list_items()` / `get_item(slug)` | read | listings status per platform |
| `delist(slug, platform)` | job, destructive | once `delist` flows exist (ARCHITECTURE §8) |

- **Where the LLM works:** interview, ad text (the `post-ad` skill's rules become the server's `prompts` entry or tool descriptions), category and field choice via the snapshot tools, and explaining failures. **Deterministic:** everything in `flow.ts` and the platform files. The model never drives the browser. This keeps the current "record once, replay forever" contract.
- **Human-in-the-loop:** two gates.
  1. Claude Desktop's own per-tool permission prompt, with `publish` marked destructive and never "always allow".
  2. `publish` only accepts a `job_id` in state `ready_to_publish`, reached after the user has seen the screenshot.

  Filling once and then publishing the same page avoids today's fill-twice (dry run, then real run). The `submitted` idempotency guard in `flow.ts` carries over as is.
- **Repair from Desktop is not realistic.** Claude Desktop cannot edit the installed bundle's TypeScript. Keep repair in Claude Code on the repo. Desktop only reports the step, the error and the aria snapshot.

## 4. Packaging

- **Node runtime:** provided by Claude Desktop. Do not bundle one.
- **Native deps:** `sharp` ships per-platform prebuilt packages (`@img/sharp-<os>-<arch>`), so one `.mcpb` must include darwin-arm64, darwin-x64 and win32-x64 variants, or be built per platform (unverified which is less painful with `mcpb pack`).
- **Browser:**
  - *Chromium (today):* don't put the ~150–200 MB browser in the bundle. Run `patchright install chromium` on first start into the Playwright cache (`~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`). Chrome-for-Testing builds are Google-signed, and files downloaded by Node carry no quarantine xattr, so Gatekeeper should not prompt (unverified). The alternative `channel: "chrome"` (installed Google Chrome) avoids the download.
  - *Firefox via `moz-firefox`:* requires installed Firefox at the default path and pins you to whatever version the user auto-updates to. Every Firefox release can break the experimental channel.
  - *Firefox via Juggler:* `playwright install firefox` downloads the patched, unbranded build. It is stable but loses the "real Firefox" argument. Redistributing a patched Firefox yourself raises Mozilla trademark questions, which downloading Playwright's build avoids (unverified).
- **Data location:** move `items/`, `sessions/`, `.cache/`, `config.yaml` out of the repo into a `user_config` directory defaulting to `~/Library/Application Support/ads-crosspost` / `%APPDATA%\ads-crosspost`. `ROOT` in `record.ts` becomes that directory. Sessions are credentials: keep them out of iCloud/OneDrive-synced folders.
- **Notarization:** a `.mcpb` is a zip run by Claude Desktop's Node, so there is no app bundle to notarize. Apple notarization only matters if you later wrap it in a standalone `.app`. On Windows, SmartScreen does not apply to a `.mcpb` opened by Claude (unverified). Sign the bundle with `mcpb sign` if others install it.
- **Selector/flow updates:** flows are code, so an update means shipping a new `.mcpb` version (manual reinstall, since the directory route is closed). Downloading flow code at runtime from a URL is remote code execution against logged-in marketplace sessions, so avoid it. `fields.json` snapshots are data and *could* be refreshed at runtime, but they are generated by logging in, so `discover` belongs in the dev repo, not the app.

## 5. Migration effort and plan

### What ports unchanged
- `record.ts` (schema, `setListing`) except `ROOT`
- `photos.ts`
- `platforms/*.ts`: step code, `SEL` maps, `CONDITION` tables. On Firefox, only the `import type { Page } from "patchright"` line changes to `"playwright"`.
- `*.categories.json`, `*.fields.json`
- `flow.ts` step loop, idempotency and failure dump. It needs a split: `runUntilSubmit()` returns an open page, and `publish()` runs the rest. It also needs to stop using `console.log` as its result channel. stdout is the MCP stdio transport, so any stray `console.log` in the flows corrupts it. Route them to stderr or a logger. **This is the one easy-to-miss bug.**
- `post-ad` skill text becomes MCP `prompts` / tool descriptions.

### What changes
- `browser.ts`: for Firefox, `firefox.launchPersistentContext(dir, { channel: "moz-firefox", headless: false })` from `playwright`. `viewport: null` and `slowMo` carry over.
- `cli.ts` gets a sibling `mcp.ts` (MCP TS SDK, stdio) plus a job manager (a map of `job_id` to context/page/state).
- `discover.ts` stays a dev-only CLI.
- Re-login on every platform if the engine changes. Re-verify each flow with a dry run. Firefox differences in native `<select>` handling (Blocket) and masked inputs (Vinted price `pressSequentially`) are the likely breakpoints (unverified).

### Phased plan
1. **MCP wrapper on the current stack (Chromium/patchright).** Add `mcp.ts`, move stdout logging to stderr, add the job manager and `prepare_post`/`publish` split, and `add_photos(folder)`. Run it from `claude_desktop_config.json` pointing at `node src/mcp.ts` in the repo. No packaging yet. Success: one real item posted to Tradera from Claude Desktop with the screenshot confirmation.
2. **Package as `.mcpb`** with the data dir moved to Application Support, `sharp` variants, and first-run browser install. Install it on your own machine only.
3. **MCP App drop zone + review panel** (optional). Build it only if the folder-path step turns out to be the annoying part.
4. **Firefox experiment, per platform, behind a flag** (`engine: "chromium" | "firefox"` in config). Start with Blocket (no DataDome, shadow DOM is the interesting test), then Tradera. Try Vinted/Facebook on Firefox only if they checkpoint the Chromium profile, and then as a fresh Firefox-only account history, not a switch.

### Recommendation and tradeoffs
- **Do phases 1–2 on patchright/Chromium.** Everything the MCP idea needs is independent of the engine. Changing both at once makes every failure ambiguous (is it MCP, Firefox, or the site?).
- **Don't adopt Gecko/BiDi now:**
  - The Playwright channel is undocumented and experimental.
  - `navigator.webdriver` is exposed with no off switch.
  - Every account would look like it moved to a new device.
  - Puppeteer, WebdriverIO and Selenium on BiDi would each force a locator rewrite.
- Revisit when Playwright documents `moz-firefox`, or when patchright Chromium starts getting checkpoints.
- **Simpler alternative worth stating:** Claude Desktop has a Code tab that runs Claude Code locally. The existing repo, `post-ad` skill and `pnpm post` would work there today with zero new code. The MCP route is only worth building if the goal is the plain chat UX, or other people using it.

## 6. ToS and distribution risk

- Personal use: unchanged from BROWSER-AUTOMATION.md §3.
  - Meta ToS bars automated access "without our prior permission" ([Meta terms](https://www.facebook.com/terms/)).
  - Vinted's terms bar "external software tools, including bots" ([selleraider summary](https://selleraider.com/vinted-terms-and-conditions-update/), secondary).
  - Blocket's and Tradera's automation clauses are unverified.
  - The realistic outcome is a checkpoint or a temporary Marketplace/Vinted restriction on *your* account.
- **Distributing to others is a different category:**
  1. You would be shipping a tool whose purpose is to breach platform ToS, which invites takedown/C&D risk. Vinted in particular sells DataDome protection as a product.
  2. Other users' account bans become your support problem.
  3. Every site change breaks everyone at once, and fixes need a re-release.
  4. You would hold responsibility for a local process that has live sessions to four marketplaces.
  5. If more users mean more posts from similar fingerprints, detection gets easier for everyone.

  If you share it, keep it source-available for self-hosting rather than a polished one-click bundle. Keep Tradera on its official seller API (ARCHITECTURE §9 Q3) where possible.
