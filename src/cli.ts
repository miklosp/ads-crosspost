import { parseArgs } from "node:util";
import type { BrowserContext, Page } from "patchright";
import { openBrowser } from "./browser.ts";
import { discover } from "./discover.ts";
import { delist, prepare, publish, type Failed } from "./flow.ts";
import { log } from "./log.ts";
import { FLOWS, flowFor } from "./platforms/index.ts";
import { FormRejected, type Flow } from "./platforms/types.ts";
import { loadRecord, markSold, PLATFORMS, setListing, type PlatformName } from "./record.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string", short: "p" },
    on: { type: "string" }, // sold: the platform it sold on
    "dry-run": { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
  },
});
const [cmd, ...args] = positionals;
const arg = args[0];

// exit code semantics: 0 = posted or already posted, 1 = failed
// browser() opens the platform's browser on first use; the caller closes it after its last item
async function runPost(flow: Flow, slug: string, dryRun: boolean, browser: () => Promise<BrowserContext>): Promise<number> {
  const p = flow.platform;
  const failed = (r: Failed) => {
    const why = r.error instanceof FormRejected ? `: ${r.error.message}` : "";
    log(`${p} FAILED at step "${r.step}"${why} — see ${r.dir}/`);
    return 1;
  };
  // fresh tab per item: a failed run leaves a half-filled form, and close() skips its beforeunload prompt
  let page: Page | undefined;
  try {
    const r = await prepare(flow, slug, async () => (page = await (await browser()).newPage()), { dryRun });
    if (r.kind === "already_posted") {
      log(`${p} posted ${r.url}`);
      return 0;
    }
    if (r.kind === "blocked") {
      if (r.reason === "submitted") log(`${p} has status "submitted" without a url — check the site manually, then \`pnpm post ${slug} --platform ${p} --reset\``);
      else log(`${p}: no platforms.${p} block in item.yaml`);
      return 1;
    }
    if (r.kind === "failed") return failed(r);
    if (dryRun) {
      log(`${p} dry-run ok — see ${r.screenshot}`);
      return 0;
    }
    const posted = await publish(r.handle);
    if (posted.kind === "failed") return failed(posted);
    log(`${p} posted ${posted.url}`);
    return 0;
  } finally {
    await page?.close();
  }
}

// exit code semantics: 0 = delisted or nothing live, 1 = failed
async function runDelist(p: PlatformName, slug: string, status: "sold" | "delisted"): Promise<number> {
  const browser = await openBrowser(p);
  try {
    const r = await delist(flowFor(p), slug, () => browser.newPage(), status);
    if (r.kind === "failed") {
      log(`${p} delist FAILED at step "${r.step}" — see ${r.dir}/`);
      return 1;
    }
    log(r.kind === "delisted" ? `${p} ${status}` : `${p}: no live listing`);
    return 0;
  } finally {
    await browser.close();
  }
}

if (cmd === "login" && arg) {
  const flow = flowFor(arg);
  const browser = await openBrowser(flow.platform);
  await (browser.pages()[0] ?? (await browser.newPage())).goto(flow.loginUrl);
  log(`log in to ${flow.platform} in the browser window, then close it`);
  await browser.waitForEvent("close", { timeout: 0 });
} else if (cmd === "discover" && arg) {
  await discover(flowFor(arg).platform);
} else if (cmd === "post" && arg && values.platform) {
  // platform-major so each site's browser opens once for all items.
  // "all" = every platform the record has a block for; naming one explicitly still errors if the block is missing
  const recs = args.map((slug) => ({ slug, rec: loadRecord(slug) }));
  const targets = values.platform === "all" ? PLATFORMS.filter((p) => FLOWS[p] && recs.some(({ rec }) => rec.platforms[p])) : [values.platform];
  let code = 0;
  for (const name of targets) {
    const flow = flowFor(name);
    let ctx: Promise<BrowserContext> | undefined;
    const browser = () => (ctx ??= openBrowser(flow.platform));
    try {
      for (const { slug, rec } of recs) {
        if (values.platform === "all" && !rec.platforms[flow.platform]) continue;
        if (values.reset) setListing(slug, flow.platform, undefined);
        if (recs.length > 1) log(`— ${slug}`);
        code = Math.max(code, await runPost(flow, slug, values["dry-run"], browser));
      }
    } finally {
      if (ctx) await (await ctx).close();
    }
  }
  process.exit(code);
} else if (cmd === "sold" && arg) {
  if (values.on) flowFor(values.on); // validate before changing the record
  let code = 0;
  for (const p of markSold(arg)) code = Math.max(code, await runDelist(p, arg, p === values.on ? "sold" : "delisted"));
  process.exit(code);
} else if (cmd === "delist" && arg && values.platform) {
  process.exit(await runDelist(flowFor(values.platform).platform, arg, "delisted"));
} else {
  log("usage:\n  pnpm run login <platform>\n  pnpm discover <platform>\n  pnpm post <slug>... --platform <p|all> [--dry-run] [--reset]\n  pnpm sold <slug> [--on <p>]\n  pnpm delist <slug> --platform <p>");
  process.exit(2);
}
