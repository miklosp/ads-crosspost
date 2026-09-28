# Quickstart

From a fresh clone to your first ad, on macOS with Claude Desktop. Plan on 15 minutes, most of it spent logging in to the four sites.

There's no notarized download yet, so step 1 builds the app yourself.

## 1. Build and install the app

You need Node 22.18 or newer and pnpm.

```sh
git clone <this repo> ads-crosspost
cd ads-crosspost
pnpm install
pnpm app:dist
```

This builds an unsigned `.dmg` for Apple silicon in `dist/`. Open it and drag **Ads Crosspost** to Applications. You built it on your own Mac, so macOS won't quarantine it, and it opens without the "unidentified developer" warning.

> [!note] Intel Mac
> `app:dist` builds arm64 only. On an Intel Mac, run `pnpm app:dev` instead. It runs the app straight from the checkout, so keep the checkout where it is.

## 2. First launch

Open Ads Crosspost. It has no Dock icon; look for it in the menu bar.

On first launch it downloads its own Chromium (about 160 MB) into the app's data folder. The window shows progress. It never uses your everyday Chrome profile.

## 3. Set your postcode

Blocket wants a postcode instead of a free-text location. Add it to `~/Library/Application Support/ads-crosspost/config.yaml`:

```yaml
postcode: "12345"
```

The other settings (photo inbox, idle browsers, hidden windows) are in the app window under **Settings**. `config.example.yaml` lists every key.

## 4. Connect Claude Desktop

In the menu bar icon, choose **Connect → Claude Desktop (chat + Cowork)**. This adds an `ads-crosspost` entry to `claude_desktop_config.json` and makes a backup of the old file first.

Quit and reopen Claude Desktop. The tools show up in both chat and Cowork.

ChatGPT desktop works the same way (**Connect → ChatGPT desktop**), but only in Work/Codex mode.

## 5. Post your first item

1. Put the item's photos in `~/Pictures/Ads Inbox`. The folder is created on first use.
2. In Claude Desktop, say something like "I want to sell my IKEA Poäng armchair".
3. Answer Claude's questions about condition, price, location and shipping. It asks everything missing in one go.
4. Check the Swedish and English text and ask for changes until you're happy with it.
5. Claude posts to one site at a time. The first time on each site it reports `needs_login` and opens a browser window. Log in there by hand, then tell Claude you're done.
6. For each site Claude shows a screenshot of the filled form. Say yes to publish it, or say what to fix.

After import, the photos move to `~/Pictures/Ads Inbox/imported/<slug>/`, so the inbox is empty for the next item.

## When something goes wrong

- **Claude says the app isn't running.** Open Ads Crosspost from Applications. Normally the connection starts it for you, but it gives up after 30 seconds.
- **A post fails at a step.** Claude reports the step and the error. Screenshots and a page snapshot are saved under `items/<slug>/runs/<site>/` in the data folder. The site has usually changed its form, and the flow needs fixing.
- **No notifications.** Since Electron 42, macOS only shows notifications from signed apps. Watch the "needs attention" line in the menu bar instead.
- **A site logs you out.** Claude reports `needs_login` again. Log in, and it picks up where it stopped.
