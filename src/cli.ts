import { parseArgs } from "node:util";
import type { BrowserContext } from "patchright";
import { openBrowser } from "./browser.ts";
import { discover } from "./discover.ts";
import { runPost } from "./flow.ts";
import { blocket } from "./platforms/blocket.ts";
import { facebook } from "./platforms/facebook.ts";
import { tradera } from "./platforms/tradera.ts";
import { vinted } from "./platforms/vinted.ts";
import type { Flow } from "./platforms/types.ts";
import { loadRecord, PLATFORMS, setListing, type PlatformName } from "./record.ts";

const FLOWS: Partial<Record<PlatformName, Flow>> = { blocket, facebook, tradera, vinted };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string", short: "p" },
    "dry-run": { type: "boolean", default: false },
    reset: { type: "boolean", default: false },
  },
});
const [cmd, ...args] = positionals;
const arg = args[0];

function flowFor(name: string): Flow {
  const f = FLOWS[name as PlatformName];
  if (!f) throw new Error(`no flow for "${name}" (have: ${Object.keys(FLOWS).join(", ")})`);
  return f;
}

if (cmd === "login" && arg) {
  const flow = flowFor(arg);
  const browser = await openBrowser(flow.platform);
  await (browser.pages()[0] ?? (await browser.newPage())).goto(flow.loginUrl);
  console.log(`log in to ${flow.platform} in the browser window, then close it`);
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
        if (recs.length > 1) console.log(`— ${slug}`);
        code = Math.max(code, await runPost(flow, slug, { dryRun: values["dry-run"] }, browser));
      }
    } finally {
      if (ctx) await (await ctx).close();
    }
  }
  process.exit(code);
} else {
  console.log("usage:\n  pnpm run login <platform>\n  pnpm discover <platform>\n  pnpm post <slug>... --platform <p|all> [--dry-run] [--reset]");
  process.exit(2);
}
