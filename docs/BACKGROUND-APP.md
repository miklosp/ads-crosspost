# Background app and MCP server: findings so far

Written 2026-09-26. Parked while we post the backlog. Pick it up from "Next steps".

## What we want

Install an app, connect Claude Desktop to it, give it photos and a description, and have it post the
ad to all four sites. No browser window should jump in front of whatever I'm doing.

## Keeping the browser out of sight

Headless is off the table. It's the main thing anti-bot systems look for, so the browser stays
headed and just has to be somewhere I'm not looking. Tested on macOS with two monitors:

| Approach | Result |
|---|---|
| `--window-position=-3000,-3000` or `-8000,-8000` | macOS clamps the window onto the nearest display. With a monitor on the left, it's still visible. |
| Minimize over CDP (`Browser.setWindowBounds`, `windowState: "minimized"`) | Form steps all pass and pages still report `visible`, but screenshots hang. Dry-run and failure captures break. |
| [SimpleDisplay](https://github.com/SamuelRioTz/SimpleDisplay) virtual monitor | Works. The window opens on a 1440×900 display called `Ads` that no one looks at. Screenshots work, and Blocket, Vinted and Facebook dry-runs pass. |

This is in the code now. `window_display: Ads` in `config.yaml` makes `browser.ts` look up that
display's frame with `osascript` (`NSScreen`) at launch and pass its top-left to Chromium as
`--window-position`. Chromium has no "open on display X" flag, but any point inside the display
works, so looking it up by name survives rearranging monitors. If the display is missing, you get a
warning and a normal window.

SimpleDisplay needs to be running, with the display created once:
`open "simpledisplay://create?width=1440&height=900&name=Ads"`. Commands from Claude Code's sandbox
can't reach the URL scheme (LaunchServices can't see the app), so run that from a normal terminal.

**Still broken: focus.** Every Chromium launch activates the app and takes keyboard focus for a
moment. `pnpm post` launches a fresh browser per site per run, so posting four items means the focus
jumps a dozen times. The fix is a browser per site that starts once and stays open, fed by a job
queue. That also removes the per-post startup time.

## MCP server for Claude Desktop

Full research with sources: [MCP-BIDI-RESEARCH.md](MCP-BIDI-RESEARCH.md). The parts that shape the
design:

- **Keep patchright and Chromium, don't switch to Firefox.** Playwright can drive stock Firefox over
  WebDriver BiDi (the undocumented `moz-firefox` channel), and the flows would port with little
  change. But Firefox sets `navigator.webdriver = true` under remote control with no way to turn it
  off, and every account would look like it moved to a new device. That's worse on Vinted, not
  better. [dig2browser](https://github.com/ZENG3LD/dig2browser) (Rust, injected-JS stealth) and
  [lurien-browser](https://github.com/santhreal/lurien-browser) (one-person Camoufox fork) were
  looked at and rejected for the same reasons, plus maturity.
- **Photos dropped in the chat never reach the server.** Claude sees them, but a tool can't receive
  the bytes. The workable version is `add_photos(folder)`: copy from a folder, return thumbnails so
  Claude sees them while writing. An in-chat drop zone (an MCP App) might work, unverified.
- **Claude Desktop cancels tool calls at about 60 seconds.** A post takes 1–3 minutes. So tools
  queue a job and return right away, and the app runs the queue. That's the same queue the focus
  fix needs.
- **Publishing is a two-step job.** `prepare_post` fills the form and keeps the page open.
  `get_status` returns the screenshot. `publish` clicks submit on the page I've already seen. That
  fills each form once, where today it's once for the dry-run and again for the real post.
- **One bug to fix first:** the flows print progress with `console.log`. On a stdio MCP server,
  stdout is the protocol channel, so those lines break the connection. Move them to stderr.
- **Packaging:** a `.mcpb` bundle, with Node supplied by Claude Desktop. Download Chromium on first
  run rather than bundling it. `items/`, `sessions/` and `config.yaml` move to Application Support.
  Don't fetch flow code at runtime. It would run with logged-in marketplace sessions.
- **Keep it personal.** Handing this to other people means shipping a tool built to break Meta's and
  Vinted's terms, with everyone's accounts breaking together whenever a site changes.

## How the pieces fit

One background app, living in the menu bar, owns three things:
1. a long-lived patchright browser per site, parked on the `Ads` display;
2. a job queue that runs one post at a time at human pace;
3. the MCP server Claude Desktop talks to.

The existing `record.ts`, `photos.ts`, platform flows and `fields.json` snapshots carry over.
`flow.ts` gets split into "fill up to submit" and "submit".

## Next steps

1. Move all flow output from stdout to stderr.
2. Split `runPost` into `prepare` (returns the open page) and `publish`.
3. A small daemon that holds one browser per site and takes jobs from a queue, driven by the CLI first.
   Done when posting four items takes focus once.
4. `mcp.ts` on top of that queue, wired into `claude_desktop_config.json` straight from the repo.
   Done when one real Tradera post goes through from Claude Desktop, with the screenshot shown before
   publishing.
5. Only then: `.mcpb` packaging, and the drop zone if the folder step turns out to be annoying.

Open question: can the daemon start SimpleDisplay's `Ads` display itself, or does that need a
one-time manual step each login?
