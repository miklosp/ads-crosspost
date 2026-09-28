# ads-crosspost — architecture

Personal tool. One item record on disk → posted to Blocket, Tradera, Vinted, Facebook Marketplace by
replaying recorded browser flows. The LLM writes ad text and repairs broken flows; it never drives a
post.

Status 2026-09-26: all four `post` flows are recorded and in use (Blocket v4, Tradera v6, Vinted v5,
Facebook v3). `delist`, `sold` and the `repair-flow` skill are not built. Per-category form fields for
every site are snapshotted in `src/platforms/<p>.fields.json` (see [FIELDS.md](FIELDS.md)).

## 1. Language: TypeScript

Playwright is TypeScript-first (Python bindings track it, but codegen, trace viewer, `ariaSnapshot`,
and docs land in TS first), and `agent-browser` is an npm-distributed CLI (unverified), so the
discovery and replay layers share one runtime and one `pnpm` toolchain. The code volume is small
either way (a loader, a photo resizer, four flow files); the deciding factor is that the uploader
files are the part the LLM will read and patch, and the most examples it can pattern-match against
for Playwright selectors are TS. `sharp` covers resizing. Python would be equally fine; the only
reason to switch is if the research agent's browser layer turns out to be Python-only.

## 2. Directory layout

```
ads-crosspost/
  .claude/skills/
    post-ad/SKILL.md          # exists: interview → item.yaml + sv/en text
    repair-flow/SKILL.md      # later: fix a failing uploader step (see §5)
  docs/
    ARCHITECTURE.md  BROWSER-AUTOMATION.md  FIELDS.md
  config.yaml                 # seller-level settings (postcode)
  items/
    <slug>/
      item.yaml               # the record (committed)
      photos/                 # originals as given (gitignored, already)
      out/<platform>/         # resized copies, regenerable (gitignored)
      runs/<platform>/<ts>/   # failure artifacts: screenshot, aria.txt, error.txt (gitignored)
  sessions/<platform>/        # Chrome user-data-dir per platform (gitignored, already)
  src/
    cli.ts                    # login | discover | post [--dry-run] [--reset]   (sold/delist: not built)
    config.ts                 # loads config.yaml
    record.ts                 # load/validate/write item.yaml (only writer)
    photos.ts                 # resize into items/<slug>/out/<platform>/
    browser.ts                # patchright persistent context on sessions/<platform>
    flow.ts                   # runPost(): named steps, artifacts on failure, idempotency guard
    discover.ts               # snapshot every category's form fields → platforms/<p>.fields.json
    platforms/
      types.ts                # Ctx / Step / Flow types
      blocket.ts  tradera.ts  vinted.ts  facebook.ts
      <p>.categories.json     # category paths the skill picks from
      <p>.fields.json         # per-category fields, options, required flags (generated)
  .cache/discover/<p>/        # raw discovery responses, resume cache (gitignored)
  package.json  tsconfig.json  .gitignore
```

Gitignored: `items/*/photos/` (binaries; re-copied from phone/originals if lost — accepted),
`items/*/out/`, `items/*/runs/`, `sessions/` (cookies = credentials, never committed), `.cache/`. Committed:
`item.yaml` — the record is text and history matters (what was posted where, at which flow version).
Alternative rejected: git-lfs for photos; not worth a second tool for a personal repo.

No secrets in the repo. Logins are done by a human in a headed browser (§6); if a platform ever needs
an API key, it comes in via `op run -- pnpm ...`.

## 3. Item record — `item.yaml`

YAML, not JSON: the record carries multi-line sv/en descriptions and is hand-edited after the
interview; block scalars and comments matter more than strict parsing. Validated with `zod` in
`record.ts` on every load; unknown keys are an error. Extends the schema the skill already writes.

```yaml
slug: ikea-poang-armchair          # == folder name
created: 2026-09-11
status: draft                      # draft | ready | posted | sold | delisted (set by hand; uploaders only touch listings)
item:
  type: armchair
  brand: IKEA                      # typed into each site's brand field where it has one
  model: Poäng
  condition: good                  # canonical: new_with_tags | new | like_new | good | fair | poor
  defects: "Small scratch on left armrest"
  included: "Cushion"
  age: "Bought 2021"
  dimensions: "68×82×100 cm"
  reason: "Moving"
price:
  sek: 400
  negotiable: true
location: "Stockholm, Södermalm"   # free text for the ad only; forms get the postcode from config.yaml
shipping: false
photos: [photos/01.jpg, photos/02.jpg]   # ordered, first = cover
ad:
  sv: {title: "", description: |
      ...}
  en: {title: "", description: |
      ...}

platforms:                         # per-platform inputs; a key present = post there
  blocket:
    category: "Möbler och inredning / Fåtöljer och stolar"   # "Huvudkategori / Underkategori" labels
    package: medium                # shipping: true only — small | medium | large | xl
    product_category: "…"          # optional, clothing/shoes etc.: "Produktkategori" (3rd taxonomy level)
    colour: "Brun"                 # optional selects/autocompletes, only where the category has them
    material: "Ull"
    fit: "Normal i storleken"
    size: "L"
  tradera:
    category: "Möbler & Inredning / Stolar & Fåtöljer"   # full path to a leaf
    mode: fixed                    # fixed | auction (auction flow not recorded)
    start_sek: 1                   # auction only
    days: 7
    weight: "5 kg"                 # shipping: true only — Tradera's label
    package: large                 # shipping: true only — small | medium | large
  vinted:                          # shipping-only site: omit when shipping: false
    category: "Home / Furniture / Chairs & seating / Armchairs"   # full path to a leaf
    package: large                 # required — small | medium | large
    colours: [Beige, Brown]        # required, 1–2 of Vinted's English colour names
    size: "L"                      # required by categories with a size grid
  facebook:
    category: "Furniture"
    tags: ["fåtölj", "armchair"]   # optional "Product tags", max 20
  # every platform also takes lang: sv | en | both (default both)

listings:                          # written ONLY by uploaders
  blocket:
    status: posted                 # submitted | posted | failed | delisted
    url: https://www.blocket.se/123456
    id: "123456"
    posted_at: 2026-09-11T10:12:00Z
    flow_version: 3                # Flow.version of blocket.ts at post time
    failed_step: category          # only when status: failed/submitted after a crash
```

Rules:
- Canonical `item.condition` maps to each site's enum in a table inside that platform file
  (`CONDITION` in each platform file; exact labels are in the fields snapshots). There is no
  per-platform override yet.
- Categories are stored as the site's visible path text, not numeric IDs: text is what the flow
  clicks in the picker. Valid paths live in `src/platforms/<p>.categories.json`; the fields each
  category asks for (and which are required) live in `src/platforms/<p>.fields.json`, generated by
  `pnpm discover <p>` — see [FIELDS.md](FIELDS.md). A wrong path fails at the `category` step.
- Every ad defaults to `lang: both`: title from `ad.sv`, description = sv, blank line, en. No price in
  text (site price field).

## 4. Uploader contract

```
pnpm post <slug>... --platform <p|all> [--dry-run] [--reset]   exit 0 = posted (or already posted), 1 = failed
```

`--platform all` posts to every platform the record has a `platforms.<p>` block for. `--reset` clears
`listings.<p>` first (after checking the site by hand).

Input: `items/<slug>/` (record + photos). Output: `listings.<p>` in `item.yaml`, plus one line on
stdout: `blocket posted https://...` — so the skill can call it from Bash at negligible token cost.

Shape (in `platforms/types.ts`):

```ts
type Step = { name: string; run: (page: Page, ctx: Ctx) => Promise<void> }
type Flow = { platform: PlatformName; version: number; loginUrl: string; maxPhotos: number; post: Step[]; delist: Step[] }
// ctx: record, config, resized photo paths, title/description for this platform's lang, result {url, id}
```

Each platform file exports one `Flow`: a `SEL` object at the top, a `CONDITION` map, then ordered
named steps. Order differs per site (Facebook, Tradera and Vinted upload photos first because it
triggers their autofill); every flow ends with `submit`, `capture_url`. `flow.ts` runs them and owns everything cross-cutting:

- **Idempotency.** If `listings.<p>.status` is `posted` → print the URL, exit 0, touch nothing.
  Immediately *before* the `submit` step, write `status: submitted` to disk; on `capture_url`
  success write `posted` + url/id. On a rerun, `submitted` without a url → refuse with "check the
  site manually, then `pnpm post ... --reset`". This is the only defence against double-posting
  when the crash lands between clicking submit and reading the URL.
- **Failure.** Any step throwing writes `items/<slug>/runs/<p>/<ts>/` with `screenshot.png`,
  `aria.txt` (`page.locator('body').ariaSnapshot()` — text, LLM-readable, cheaper than a full DOM),
  `error.txt` (step name, selector, Playwright error), and sets `listings.<p>.status: failed`,
  `failed_step: <name>`. Stdout: `blocket FAILED at step "category" — see runs/blocket/<ts>/`.
- **Dry run.** `--dry-run` executes every step up to and excluding `submit`, screenshots the
  filled form, then closes. This is the regression test after a repair and the acceptance test
  after recording. No record changes.
- Photos are uploaded with `setInputFiles` on the hidden `<input type=file>` — no drag-and-drop
  — using the resized copies from `out/<p>/`.
- No retries inside a step. A flaky selector is a repair, not a loop.

Browser: `browser.ts` launches a patchright persistent context on `sessions/<p>`, headed, bundled
Chromium, `slowMo` 300–800 ms; `flow.ts` adds 300–800 ms jitter between steps.

## 5. Record once, replay forever

LLM enters exactly three times: writing the ad (skill), recording a flow (once per platform per
action), repairing a flow (when a site changes). Everything else is `pnpm` commands.

**Record (once per platform).**
1. `pnpm run login <p>` opens headed Chrome on `sessions/<p>/`; the human logs in (BankID for Blocket,
   unverified); close. Session persists.
2. In a Claude Code session, the LLM drives `agent-browser` on the same profile through the
   posting form using a real draft item, taking snapshots and noting for each step the most stable
   locator (`getByRole`/`getByLabel`/`data-testid` first, CSS last) and any quirks (category picker
   is a search box, condition is a radio group, description is contenteditable, etc.).
3. The LLM writes `src/platforms/<p>.ts` — `SELECTORS` + steps — and stops.
4. Human runs `pnpm post <slug> --platform <p> --dry-run`, checks the screenshot, then the real
   post. First real listing = accepted. Commit.

**Replay.** `pnpm post <slug> --platform blocket` (or `--platform all`). No LLM.

**Field snapshot.** `pnpm discover <p>` reads the site's own field-definition data for every category
(read-only, no drafts published) and rewrites `src/platforms/<p>.fields.json`. Rerun after a site
redesign or when a `details`-type step starts failing. Tradera and Vinted make one paced request per
category (~75 and ~60 min at the built-in pacing); Blocket needs one request, Facebook ~25 clicks.

**Version.** Git is the history; `version` in the `Flow` is bumped on any edit and stamped into
`listings.<p>.flow_version`, so a record says which flow produced it.

**Repair (when a step fails).**
1. Human runs `/repair-flow <slug> <p>` (skill, to be written).
2. Skill reads `runs/<p>/<latest>/error.txt` + `aria.txt` (+ screenshot only if the aria is
   ambiguous). Most repairs are one selector in `SELECTORS`. If the page structure changed
   (new step, reordered form), it may open `agent-browser` on the profile for a live look.
3. Edits the platform file, bumps `version`, runs `--dry-run`, confirms the failing step passes.
4. Human runs the real post. LLM exits.

Token budget is bounded by design: a repair reads one small text file and one aria snapshot,
never the whole site.

Why code steps and not a declarative JSON step list: three of the four sites need conditionals
(auction vs fixed, brand autocomplete, "add more photos" reveal, cookie banner on first visit).
A JSON interpreter grows into a worse Playwright. Named steps with a hoisted selector map get the
"repair = small diff" property without the interpreter.

## 6. Sessions

One `sessions/<p>/` Chrome profile per platform: a Facebook checkpoint doesn't poison Blocket, and
each profile only ever visits one site. Driven by **patchright** (drop-in Playwright fork that removes
the CDP `Runtime.enable` tell — see BROWSER-AUTOMATION.md §2), bundled Chromium (decision 2026-09-11: user preference; flip to `channel: "chrome"` per platform only if Vinted/FB checkpoint), headed, no
automation-controlled flag, human-typed logins (unverified whether this is enough for Facebook and Vinted long-term). Session
lifetime per site is unknown; `pnpm post` should detect a login page at `open_form` and fail
with a clear "run `pnpm run login <p>`" rather than proceeding.

Keeping the window out of the way: `window_display` in `config.yaml` opens it on a named display (a
SimpleDisplay virtual monitor). Findings and the background-app plan are in [BACKGROUND-APP.md](BACKGROUND-APP.md).

## 7. Photos

`photos.ts` regenerates `out/<p>/NN.jpg` from `photos/` before every post: longest edge ≤ 2000 px,
JPEG q85, **EXIF stripped** (home photos carry GPS). Order preserved; first = cover. Per-platform
count cap, all (unverified) — to be confirmed during recording and hardcoded per flow:

| platform | `maxPhotos` in flow | notes |
|---|---|---|
| Blocket | 10 | unverified; the form only says "five or more photos sell faster" |
| Tradera | 12 | unverified; Tradera support says 40 per listing, 2 MB each |
| Vinted | 20 | |
| Facebook | 10 | form says "up to 10 photos" |

If the record has more photos than the cap, take the first N and warn.

## 8. Status tracking — later, design only

- `pnpm sold <slug> --on tradera`: sets `status: sold`, `listings.tradera.status: sold`, then runs
  the `delist` flow for every other platform whose status is `posted`. Each `delist` is a second
  recorded step list in the same platform file (`open_my_ads`, `find_listing` by stored id/url,
  `remove`, `confirm`) with the same failure artifacts.
- `pnpm delist <slug> --platform <p>`: manual single delist.
- No polling, no cron, no "did it sell" detection. The human knows when it sold.
- Tradera auctions end on their own; `sold` on Tradera is the only case where the platform, not
  the human, decides — still triggered manually.

## 9. Open questions

Resolved since first draft: browser layer (patchright persistent context, #1); Vinted is
shipping-only, so pickup-only items skip it (#5); category taxonomies and per-category fields are
snapshotted (#7); location is the postcode in `config.yaml` for Blocket, the account's Marketplace
location for Facebook, and not asked by Tradera/Vinted (#8).

1. **Browser layer (research agent).** `launchPersistentContext` on `sessions/<p>` vs launching
   Chrome with `--remote-debugging-port` + `--user-data-dir` and CDP-attaching from both
   `agent-browser` (recording) and Playwright (replay)? Shared profile between the two tools is
   the attractive option. Resolved 2026-09-11: `launchPersistentContext` via patchright, headed
   everywhere — headless is the main detection signal, so not even for Blocket/Tradera (Tradera
   uses its API anyway).
2. **Facebook / Vinted hostility.** Does a real-Chrome persistent profile survive repeated
   automated posts, or do they checkpoint? Mobile-web (`m.facebook.com`) vs desktop — which form
   is more stable? Unknown until tried.
3. **Tradera has an official seller API** (SOAP, `api.tradera.com`, unverified whether still
   open to private sellers). If usable, it replaces one browser flow entirely; then `op run --`
   for the key.
4. **Blocket login / paid ads.** BankID on every session expiry? Some categories charge private
   sellers (unverified) — a payment step would need a `stop_before_payment` guard.
5. **Vinted pickup-only.** Vinted is shipping-centric; whether a `shipping: false` item can be
   listed at all is unverified. May be skipped for furniture.
6. **Photo caps and max dimensions** per platform — confirm during recording (§7).
7. **Category taxonomies.** Snapshot once per site so the skill can validate paths, or accept
   failures at the `category` step as the feedback loop? Start with the latter.
8. **Location field.** Blocket wants kommun/region, Facebook wants a place search, Tradera a
   postcode (unverified). Free-text `location` may need a structured `{city, postcode}` split.
