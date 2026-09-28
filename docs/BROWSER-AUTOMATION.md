# Browser automation for ads-crosspost

Researched 2026-09-11 against agent-browser 0.37.1 (local), Playwright docs (Context7), vendor sites.

> **What was actually built (2026-09-26)** differs from the recommendation below in three places:
> replay is **TypeScript** + patchright, not Python; it runs patchright's **bundled Chromium**, not
> `channel="chrome"` (user preference, see ARCHITECTURE.md §6); and **Tradera is posted through the
> web form**, not the seller API. Profiles live in `sessions/<p>/` inside the repo, one per site,
> not `~/.ads-crosspost/chrome-profile`. Failure artifacts go to `items/<slug>/runs/<p>/<ts>/`.
> The research below is kept as written.

## Recommendation (summary)

1. Use **agent-browser only for discovery**: walk each posting flow once, record stable selectors and waits. It has no record/replay or script-export feature (verified below).
2. Replay with a **Playwright (Python) script** using `launch_persistent_context(user_data_dir, channel="chrome", headless=False)` — a dedicated, non-default Chrome profile that you log into once by hand. No LLM in the loop.
3. Do **Tradera via its official API** (RestrictedService.AddItem + user token); skip the browser there entirely. Blocket, Vinted and Facebook have no private-seller API, so browser replay is the only route.
4. On any step failure the script dumps `{step, screenshot, a11y/DOM snapshot, URL}`; Claude repairs that one step (~5–15k tokens) rather than re-driving the flow (~30–60k tokens per platform).
5. Expect Vinted (DataDome) and Facebook to be the fragile ones; keep human-like pacing, headed real Chrome, one post at a time. All four ToS restrict automation to some degree — this is a personal-risk call, not a technical one.

## 1. What agent-browser is (and isn't)

- **Architecture**: Rust CLI + Rust daemon speaking **raw CDP** to Chrome. "No Playwright or Puppeteer dependency" (`agent-browser skills get core`). The Homebrew install is a Node wrapper (`bin/agent-browser.js`) that execs the native binary; daemon persists between commands and idles out after 1 h.
- **Designed for LLM-in-the-loop**: `snapshot -i` returns an accessibility tree with `@eN` refs; refs are "assigned fresh on every snapshot" and "stale the moment the page changes". They are **not** stable identifiers and cannot be stored for replay.
- **Session/auth persistence it does have**: `--profile <dir>` (Chrome user-data-dir), `--session <id> --restore` (cookies+localStorage saved under `~/.agent-browser/sessions/`), `state save/load <json>`, `--cdp <port>` / `--auto-connect` to attach to a running Chrome. `cookies set --curl` imports from a curl/cookie file.
- **Batch mode exists** (`agent-browser batch`, quoted commands or JSON array on stdin, `--bail`) — a deterministic command list can be replayed *without* an LLM, but only if every command uses `find role/label/text/testid` or CSS selectors, never `@eN`. Step-level waits are `wait @sel | --text | --url | --load networkidle | --fn`. No screenshot-on-failure, no retries, no per-step diagnostics beyond the JSON error — you would build that in a shell wrapper.
- **What it does NOT have** (checked `skills get core --full`, `batch --help`, `skills list`, README via github.com/vercel-labs/agent-browser): no action recorder, no "save flow", no Playwright/codegen-style script export. `record start/stop` is **video** (ffmpeg); `network har` records traffic; `derive-client` skill is for reverse-engineering a site's internal JSON API from a HAR — worth trying on Blocket/Vinted, but DataDome makes the Vinted variant fragile (see §3).
- Verdict: "just Chromium via CDP + agent-browser" is accurate for discovery. For unattended replay you either (a) hand-write an agent-browser `batch` file with semantic selectors, or (b) write a Playwright script. (b) wins on waits, auto-retrying locators, failure artefacts, file-upload handling and testability; agent-browser's `find` maps 1:1 to Playwright `getByRole/getByLabel/getByTestId`, so translating is mechanical.

## 2. Replay layer comparison

| Option | Session reuse | Bot-detection profile | Unattended replay | Verdict |
|---|---|---|---|---|
| (a) Playwright `launch_persistent_context(user_data_dir, channel="chrome", headless=False)` | Full Chrome profile (cookies, localStorage, IndexedDB, device fingerprint) persists on disk; log in once by hand in that window | Real Chrome, headed, persistent fingerprint. Still a CDP-driven browser: Playwright's `Runtime.enable` is detectable by DataDome/Cloudflare-class vendors ([rebrowser-patches](https://github.com/rebrowser/rebrowser-patches)); `navigator.webdriver` is set unless you pass `ignore_default_args=["--enable-automation"]` (unverified for current Playwright) | Yes — script owns the browser lifecycle | **Recommended** |
| (b) Playwright `connect_over_cdp("http://localhost:9222")` to a Chrome you started with `--remote-debugging-port` | Since **Chrome 136** the port is ignored for the *default* profile; you must pass `--user-data-dir=<non-default>` ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). So you end up with a separate profile anyway, and Chrome must already be running | Same detectability as (a) once attached (same CDP commands); marginally better because the browser wasn't launched with automation flags | Fragile: needs Chrome pre-started with the flag; port exposes full browser control to any local process | Use only for ad-hoc debugging |
| (c) raw CDP (Python `websockets`/`pychrome`) | Same as (b) | Can avoid `Runtime.enable` by design, so lowest CDP footprint | You reimplement waits, locators, uploads, dialogs — hundreds of lines | Not worth it for four forms |
| `storage_state` JSON (cookies+localStorage) into a fresh context | Only cookies/localStorage; new fingerprint each run | Worst: fresh, headless-looking profile, missing IndexedDB/device state that FB/Vinted bind sessions to (unverified) | Fine for cookie-only sites | Avoid for FB/Vinted |

Notes:
- `channel="chrome"` uses the installed Google Chrome, not Playwright's bundled Chromium — better for detection (unverified magnitude) and gets Chrome's codecs.
- One Chrome instance per `user_data_dir` at a time; keep the profile dedicated to this tool (`~/.ads-crosspost/chrome-profile`).
- **Decision (2026-09-11): use [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) from the start**, not as a fallback. It is a drop-in Playwright fork (Node: `patchright`, Python: `patchright`; same API, `import { chromium } from "patchright"`) that removes the `Runtime.enable` leak and the other known CDP tells. Zero switching cost, so there is no reason to wait until DataDome blocks a post. Still combine with real Chrome channel + headed + persistent per-site profile — patchright fixes the CDP signal, not the fingerprint/cadence side.
- Rejected: Camoufox (Firefox fork with randomised fingerprints). It is built for scale scraping with fresh identities, Python-first, weaker persistent-profile support, and a Firefox with a spoofed fingerprint appearing on accounts that have only ever seen Chrome is a bigger anomaly than a slightly leaky real Chrome.
- Playwright also now ships `playwright-cli` with `attach --cdp=chrome` for agent use, but that inherits the Chrome-136 profile restriction.
- Honest uncertainty: nobody publishes what FB/Vinted key on. Public reports suggest **volume and cadence** (dozens of posts in minutes) trigger Vinted's 24 h restriction more than the CDP signal itself ([Redrip](https://www.redrip.app/en/blog/vinted-automation-restriction-2026/), secondary source). A single headed real-Chrome post per item at human pace, driven via patchright, is the lowest-risk configuration available.

## 3. Per-platform notes (public info only)

### Tradera
- **Official API, private sellers OK**: Tradera Developer Program, SOAP v3 (`api.tradera.com/v3/*.asmx`) plus a newer REST v4 (unverified scope). `RestrictedService.AddItem` creates auctions/fixed-price items ("but not shop items" — those use `AddShopItem`). Auth = `appId` + `appKey` (from the developer program) + `userId` + user `token`. User authorises the app at `https://api.tradera.com/v3/Authenticate.aspx?appId=…`, then `PublicService.FetchToken(userId, secretKey)` ([Go client docs](https://pkg.go.dev/github.com/SebbeJohansson/tradera-go-client), [AddItem](https://api.tradera.com/v3/restrictedservice.asmx?op=AddItem)). AddItem is async — poll `GetRequestResults`. Images: "set AutoCommit to false, call [AddItemImage] for every image and then call [AddItemCommit] after the last image" (method names from the asmx page; verify against the WSDL). Sandbox: append `sandbox=1` to the token-login URL.
- Restricted (new/unproven) sellers may only list plain auctions ending ≥7 days out (client-library README, unverified against Tradera docs).
- Photos via web UI: up to 40 per listing, 2 MB per file, auto-scaled to 1024×768 ([Tradera support](https://www.tradera.com/support/se/posts/10-bilder-i-annonser/)). API image limits: not found — test in sandbox.
- Anti-bot: nothing documented. ToS re automation: API use implies acceptance of the developer terms; no scraping/bot clause found for the web UI (unverified).

### Blocket
- **No private-seller API.** Blocket API 5.0 (REST/OAuth2, replaces XML/FTP) is for dealers/companies with a Blocketbutik ("Företagsannonsering kräver Blocketbutik", [support](https://blocket.zendesk.com/hc/sv/articles/28714211252626)); the ad-import flows documented are automotive ([Tokov Media](https://tokovmedia.se/blocket-api-digital-bilhall-for-bilhandlares-hemsida/)). Unofficial packages (`blocket-api` on PyPI, blocket-api.se) are read-only search wrappers.
- Photos (private ads): older sources say 6 images; current UI limit unverified — read it off the form during discovery. Dealer admin: jpg/png, 20 KB–20 MB, recommended 1024×768 ([support](https://blocket.zendesk.com/hc/sv/articles/360001534419)).
- Private ad pricing: some categories charge per ad ([Prislista](https://blocket.zendesk.com/hc/sv/articles/22877545778962)) — the replay script must stop before any payment step.
- Anti-bot: not documented; `www.blocket.se` returned 403 to a non-browser fetch during this research, so expect at least basic bot filtering. ToS automation clause: not verified (could not fetch).

### Vinted
- **No public API** ([lobstr](https://www.lobstr.io/blog/vinted-api), [DEV](https://dev.to/datakaz/how-to-scrape-vinted-in-2026-without-getting-blocked-2a59)). Third-party "crosslister" tools exist but all drive the web UI or reverse-engineered mobile endpoints.
- **Anti-bot: DataDome** (JA3/TLS fingerprint, IP reputation, timing) — confirmed by [DataDome's own case study](https://datadome.co/customers-stories/vinted-partners-with-datadome-to-stop-account-fraud-protect-millions-in-revenue/). This is the platform most likely to flag a CDP-driven browser; residential IP + headed real Chrome is the minimum.
- ToS: "must not use external software tools, including bots, unless … allowed by Vinted" ([selleraider summary](https://selleraider.com/vinted-terms-and-conditions-update/), secondary). Accounts suspected of automated reposting get 24 h restrictions ([Redrip](https://www.redrip.app/en/blog/vinted-automation-restriction-2026/), secondary).
- Photos: up to 20 per listing; no stock/watermarked images ([Vinted help](https://www.vinted.com/help/48-what-photos-you-should-upload)). Size/format limits not published.

### Facebook Marketplace
- **No API for individual listings.** Marketplace API access is partner-only ("requires approval through Meta's partner program"; [api2cart](https://api2cart.com/api-technology/facebook-marketplace-api/)); Commerce Manager/catalog feeds cover Shops and vehicle/real-estate partners, not personal Marketplace posts.
- ToS: "You may not access or collect data from our Products using automated means (without our prior permission) … regardless of whether … logged-in" ([Meta ToS](https://www.facebook.com/terms/)); separate [Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms). Posting via a script is arguably "automated access"; enforcement outcome is usually a checkpoint/temporary Marketplace ban rather than a full account loss (unverified, anecdotal).
- Photos: up to 10 per listing ([IsoPeel guide](https://isopeel.com/guides/facebook-marketplace-image-requirements/), secondary). Meta AI now drafts listings from photos (2026-03 newsroom post) — irrelevant for automation but it changes the form UI often; expect selector churn here.
- Anti-bot: proprietary; account age, IP stability and cadence matter (forum lore, unverified). The listing form is a heavy React app — `snapshot -i` will be several thousand tokens; scope with `-s` to the form container.

## 4. Record → replay loop

Discovery (once per platform, LLM-driven, headed):
1. `export AGENT_BROWSER_SESSION=$(agent-browser session id --prefix ads)`; `agent-browser --headed --profile ~/.ads-crosspost/chrome-profile open <sell URL>`. Log in by hand in that window. (Same profile dir is reused by Playwright later — Chrome profile format is shared; close agent-browser first, only one process per profile.)
2. Walk the form with `snapshot -i -s <form>` → `click/fill @eN`. After each successful step, ask for the **durable selector** the ref resolved to: `agent-browser get attr @eN data-testid`, `get attr @eN aria-label`, `get attr @eN name`, or `snapshot --json` and read `role`+`name`. Record `{step, role/name or testid, action, wait}`; never record `@eN`.
3. Prefer, in order: `data-testid` → `getByRole(name=…)` → `getByLabel` → `getByPlaceholder` → CSS with stable attribute (`input[name=…]`) → text. Avoid class-hash CSS.
4. Record the **wait** that proved the step landed (`wait --url`, `wait --text`, element appear) — waits, not selectors, are the usual replay failure.
5. Stop at the final "Publish" click during discovery; dump the recorded step list to `flows/<platform>.yaml` (or straight to Python).

Replay (no LLM):
1. `python post.py --platform blocket --item item.json`: `launch_persistent_context(PROFILE, channel="chrome", headless=False, slow_mo=…)`; iterate steps; `set_input_files` for photos; each step wrapped in `try/except` with `expect(...).to_be_visible()` waits.
2. Failure handler: write `runs/<ts>/<platform>/<step-name>/{screenshot.png, page.aria.txt via locator("body").aria_snapshot(), page.html, url.txt, error.txt}` then exit non-zero with the step name in stdout.
3. Login check as step 0: if the sell URL redirects to a login page, exit with `NEEDS_LOGIN` — user logs in manually in the same profile; no credentials in the script.

Repair (LLM, scoped):
1. Claude reads `error.txt` + `page.aria.txt` (a few k tokens; the aria snapshot is the same shape as `agent-browser snapshot`) and edits only the failing step's selector/wait. If the aria dump is insufficient, re-open agent-browser on the same profile and re-snapshot just that page.
2. Re-run from a `--from-step` flag; the script must be idempotent up to Publish (drafts are usually fine to abandon).

`playwright codegen --channel chrome --user-data-dir ~/.ads-crosspost/chrome-profile <url>` is the alternative recorder: it emits `getByRole/getByLabel` locators directly, is zero-token, and supports the persistent profile. Downsides: it records **no waits/assertions** beyond navigation, and its React-heavy locators can be brittle. Best use: run codegen for the mechanical parts, then have Claude add waits and testids from one agent-browser pass. If you already have agent-browser open, translating its `find` commands is equally cheap.

## 5. Token cost per post (rough)

| Mode | Per platform | 4 platforms |
|---|---|---|
| (a) Naive agent-browser, LLM drives every step | 15–30 tool turns × (scoped snapshot 1–4k + reasoning ~0.3k) ≈ **30–60k** tokens; FB is the high end. Context accumulates across turns, so effective billed input is 2–3× that without prompt caching | 120–250k |
| (b) Replay, LLM only on failure | **0** on success. One broken step ≈ error + aria dump + edit ≈ **5–15k**. Empirically UI churn maybe 1 in 5–10 runs per platform (guess) → amortised **~1–3k**/platform/post | ~0–10k typical |

Discovery is a one-off ~50–100k per platform. Payback after the first 2–3 posts.
