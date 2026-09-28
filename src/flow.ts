import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "patchright";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { preparePhotos } from "./photos.ts";
import { adText, itemDir, loadRecord, setListing } from "./record.ts";
import { FormRejected, type Ctx, type Flow, type Step } from "./platforms/types.ts";

// exit code semantics: 0 = posted or already posted, 1 = failed
// browser() opens the platform's browser on first use; the caller closes it after its last item
export async function runPost(flow: Flow, slug: string, opts: { dryRun: boolean }, browser: () => Promise<BrowserContext>): Promise<number> {
  const p = flow.platform;
  const rec = loadRecord(slug);
  const existing = rec.listings[p];
  if (existing?.status === "posted") {
    log(`${p} posted ${existing.url}`);
    return 0;
  }
  if (existing?.status === "submitted" && !opts.dryRun) {
    log(`${p} has status "submitted" without a url — check the site manually, then \`pnpm post ${slug} --platform ${p} --reset\``);
    return 1;
  }
  if (!rec.platforms[p]) {
    log(`${p}: no platforms.${p} block in item.yaml`);
    return 1;
  }

  const ctx: Ctx = {
    record: rec,
    config,
    platform: p,
    photos: await preparePhotos(slug, rec, p, flow.maxPhotos),
    ...adText(rec, p),
    result: {},
  };

  // fresh tab per item: a failed run leaves a half-filled form, and close() skips its beforeunload prompt
  const page = await (await browser()).newPage();
  let submitted = false;
  const fail = async (step: Step, e: unknown) => {
    const dir = await dumpFailure(page, slug, p, step, e);
    // once submit has run the ad may be live: keep "submitted" so a rerun refuses instead of double-posting,
    // unless the site visibly refused the form
    const status = submitted && !(e instanceof FormRejected) ? "submitted" : "failed";
    setListing(slug, p, { status, failed_step: step.name, flow_version: flow.version });
    const why = e instanceof FormRejected ? `: ${e.message}` : "";
    log(`${p} FAILED at step "${step.name}"${why} — see ${dir}/`);
    return 1;
  };
  try {
    for (const step of flow.post) {
      if (step.name === "submit") {
        const errors = (await flow.formErrors?.(page)) ?? [];
        if (errors.length) return await fail({ name: "validate", run: async () => {} }, new FormRejected(errors.join("; ")));
        if (opts.dryRun) {
          const dir = runDir(slug, p);
          await page.screenshot({ path: join(dir, "dry-run.png"), fullPage: true });
          log(`${p} dry-run ok — see ${dir}/dry-run.png`);
          return 0;
        }
        setListing(slug, p, { status: "submitted", flow_version: flow.version });
        submitted = true;
      }
      try {
        await page.waitForTimeout(300 + Math.random() * 500); // pacing jitter between steps
        await step.run(page, ctx);
      } catch (e) {
        return await fail(step, e);
      }
    }
    setListing(slug, p, {
      status: "posted",
      url: ctx.result.url,
      id: ctx.result.id,
      posted_at: new Date().toISOString(),
      flow_version: flow.version,
    });
    log(`${p} posted ${ctx.result.url}`);
    return 0;
  } finally {
    await page.close();
  }
}

function runDir(slug: string, p: string) {
  const dir = join(itemDir(slug), "runs", p, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function dumpFailure(page: Page, slug: string, p: string, step: Step, e: unknown) {
  const dir = runDir(slug, p);
  writeFileSync(join(dir, "error.txt"), `step: ${step.name}\nurl: ${page.url()}\n\n${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  await page.screenshot({ path: join(dir, "screenshot.png"), fullPage: true }).catch(() => {});
  await page.locator("body").ariaSnapshot().then((a) => writeFileSync(join(dir, "aria.txt"), a)).catch(() => {});
  return dir;
}
