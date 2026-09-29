import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "patchright";
import { config } from "./config.ts";
import { preparePhotos } from "./photos.ts";
import { adText, itemDir, loadRecord, setListing } from "./record.ts";
import { FormRejected, type Ctx, type Flow, type Step } from "./platforms/types.ts";

export type Handle = { flow: Flow; slug: string; page: Page; ctx: Ctx; rest: Step[] };
export type Failed = { kind: "failed"; step: string; error: unknown; dir: string };
export type Prepared =
  | { kind: "ready"; handle: Handle; screenshot: string }
  | { kind: "already_posted"; url?: string }
  | { kind: "blocked"; reason: "submitted" | "no_platform_block" }
  | Failed;
export type Published = { kind: "posted"; url?: string; id?: string } | Failed;
export type Delisted = { kind: "delisted" | "not_posted" } | Failed;

// Fills the form up to (not incl.) "submit" and screenshots it. newPage() is called only once the guards pass;
// the caller closes that page. opts.dryRun lets a "submitted" listing be refilled, since nothing will be published.
export async function prepare(flow: Flow, slug: string, newPage: () => Promise<Page>, opts: { dryRun?: boolean } = {}): Promise<Prepared> {
  const p = flow.platform;
  const rec = loadRecord(slug);
  const existing = rec.listings[p];
  if (existing?.status === "posted") return { kind: "already_posted", url: existing.url };
  if (existing?.status === "submitted" && !opts.dryRun) return { kind: "blocked", reason: "submitted" };
  if (!rec.platforms[p]) return { kind: "blocked", reason: "no_platform_block" };

  const ctx: Ctx = {
    record: rec,
    config,
    platform: p,
    photos: await preparePhotos(slug, rec, p, flow.maxPhotos),
    ...adText(rec, p),
    result: {},
  };

  const page = await newPage();
  const i = flow.post.findIndex((s) => s.name === "submit");
  const handle: Handle = { flow, slug, page, ctx, rest: i < 0 ? [] : flow.post.slice(i) };
  const failed = await runSteps(handle, i < 0 ? flow.post : flow.post.slice(0, i));
  if (failed) return fail(handle, failed.step, failed.error, false);
  const errors = (await flow.formErrors?.(page)) ?? [];
  if (errors.length) return fail(handle, { name: "validate", run: async () => {} }, new FormRejected(errors.join("; ")), false);
  const screenshot = join(runDir(slug, p), "ready.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  return { kind: "ready", handle, screenshot };
}

// Clicks submit and runs the remaining steps (capture_url etc.) on the page prepare() filled.
export async function publish(handle: Handle): Promise<Published> {
  const { flow, slug, ctx } = handle;
  setListing(slug, flow.platform, { status: "submitted", flow_version: flow.version });
  const failed = await runSteps(handle, handle.rest);
  if (failed) return fail(handle, failed.step, failed.error, true);
  setListing(slug, flow.platform, {
    status: "posted",
    url: ctx.result.url,
    id: ctx.result.id,
    posted_at: new Date().toISOString(),
    flow_version: flow.version,
  });
  return { kind: "posted", url: ctx.result.url, id: ctx.result.id };
}

// Runs the flow's delist steps on the stored listing. `status` is what the listing becomes: "sold" on the site
// it sold on, else "delisted". A failure leaves the listing as it was, so a rerun tries again.
export async function delist(flow: Flow, slug: string, newPage: () => Promise<Page>, status: "sold" | "delisted" = "delisted"): Promise<Delisted> {
  const p = flow.platform;
  const rec = loadRecord(slug);
  const listing = rec.listings[p];
  if (listing?.status !== "posted") return { kind: "not_posted" };
  if (!flow.delist.length) throw new Error(`no delist flow recorded for ${p}`);
  const ctx: Ctx = { record: rec, config, platform: p, photos: [], ...adText(rec, p), result: {} };
  const page = await newPage();
  const step = await runSteps({ flow, slug, page, ctx, rest: [] }, flow.delist);
  if (step) return { kind: "failed", step: step.step.name, error: step.error, dir: await dumpFailure(page, slug, p, step.step, step.error) };
  setListing(slug, p, { ...listing, status });
  return { kind: "delisted" };
}

async function runSteps(handle: Handle, steps: Step[]): Promise<{ step: Step; error: unknown } | undefined> {
  for (const step of steps) {
    try {
      await handle.page.waitForTimeout(300 + Math.random() * 500); // pacing jitter between steps
      await step.run(handle.page, handle.ctx);
    } catch (error) {
      return { step, error };
    }
  }
}

async function fail({ flow, slug, page }: Handle, step: Step, e: unknown, submitted: boolean): Promise<Failed> {
  const dir = await dumpFailure(page, slug, flow.platform, step, e);
  // once submit has run the ad may be live: keep "submitted" so a rerun refuses instead of double-posting,
  // unless the site visibly refused the form
  const status = submitted && !(e instanceof FormRejected) ? "submitted" : "failed";
  setListing(slug, flow.platform, { status, failed_step: step.name, flow_version: flow.version });
  return { kind: "failed", step: step.name, error: e, dir };
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
