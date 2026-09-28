import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { BrowserContext, Page } from "patchright";
import sharp from "sharp";
import type { Flow } from "./platforms/types.ts";
import type { PlatformName } from "./record.ts";

process.env.ADS_DATA_DIR = mkdtempSync(join(tmpdir(), "ads-jobs-"));
const { createEngine, JobStateError } = await import("./jobs.ts");
const { itemDir, loadRecord, DATA } = await import("./record.ts");

const slug = "lamp";
const ITEM = `slug: lamp
created: "2026-01-01"
status: ready
item: { type: lamp, condition: good }
price: { sek: 100, negotiable: false }
location: Stockholm
shipping: true
photos: [photos/1.jpg]
ad: { sv: { title: Lampa, description: En lampa }, en: { title: Lamp, description: A lamp } }
platforms:
  tradera: { category: Lampor, mode: fixed }
  vinted: { category: Home / Lamps, package: small, colours: [Black] }
`;

beforeEach(async () => {
  mkdirSync(join(itemDir(slug), "photos"), { recursive: true });
  writeFileSync(join(itemDir(slug), "item.yaml"), ITEM);
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).jpeg().toFile(join(itemDir(slug), "photos/1.jpg"));
});

class FakePage extends EventEmitter {
  closed = false;
  href = "https://example.test/";
  url = () => this.href;
  isClosed = () => this.closed;
  goto = async (u: string) => void (this.href = u);
  bringToFront = async () => {};
  screenshot = async ({ path }: { path: string }) => writeFileSync(path, "");
  waitForTimeout = async () => {};
  locator = () => ({ ariaSnapshot: async () => "- body" });
  close = async () => {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  };
}

function fakeBrowsers() {
  const pages: FakePage[] = [];
  const get = async (_p: PlatformName) => ({
    newPage: async () => {
      const page = new FakePage();
      pages.push(page);
      return page as unknown as Page;
    },
  }) as unknown as BrowserContext;
  const log: string[] = [];
  let leased = 0;
  const lease = (p: PlatformName) => (leased++, log.push(`lease ${p}`), () => void (leased--, log.push(`release ${p}`)));
  const closeUnused = async (p?: PlatformName) => void log.push(`closeUnused ${p} leased=${leased}`);
  const reveal = async (_page: Page) => void log.push("reveal");
  return { browsers: { get, lease, closeUnused, reveal }, pages, log, leased: () => leased };
}

// "fill" waits on gate(), so tests can hold a job in "running"
function fakeFlow(platform: PlatformName, o: { loggedIn?: () => boolean; gate?: () => Promise<void> } = {}): Flow {
  return {
    platform,
    version: 1,
    loginUrl: `https://${platform}.test/login`,
    maxPhotos: 1,
    isLoggedIn: o.loggedIn && (async () => o.loggedIn!()),
    post: [
      { name: "fill", run: async () => o.gate?.() },
      { name: "submit", run: async () => {} },
      { name: "capture_url", run: async (_p, ctx) => void (ctx.result = { url: `https://${platform}.test/ad/1` }) },
    ],
    delist: [],
  };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "condition not reached");
}

test("prepare → ready_to_publish → publish → posted, emitting every change", async () => {
  const { browsers, pages } = fakeBrowsers();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { loggedIn: () => true }) }, browsers, pace: () => 0 });
  const seen: string[] = [];
  e.on("change", (j) => seen.push(j.state));
  const job = e.preparePost(slug, "tradera");
  const running = await e.waitFor(job.id, 5000);
  assert.equal(running.state, "running");
  assert.equal((await e.waitFor(job.id, 5000)).state, "ready_to_publish");
  assert.ok(e.get(job.id).screenshot);
  assert.equal(pages.length, 2); // login probe (closed) + form page (kept)
  assert.equal(pages[0].closed, true);
  assert.equal(pages[1].closed, false);
  e.publish(job.id);
  assert.equal(e.get(job.id).state, "publishing");
  const done = await e.waitFor(job.id, 5000);
  assert.equal(done.state, "posted");
  assert.equal(done.url, "https://tradera.test/ad/1");
  assert.equal(pages[1].closed, true);
  assert.deepEqual(seen, ["queued", "running", "ready_to_publish", "publishing", "posted"]);
  assert.equal(loadRecord(slug).listings.tradera?.status, "posted");
  // a second prepare of a posted listing short-circuits
  const again = e.preparePost(slug, "tradera");
  await until(() => e.get(again.id).state === "posted");
});

test("not logged in → needs_login, probe page closed", async () => {
  const { browsers, pages } = fakeBrowsers();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { loggedIn: () => false }) }, browsers, pace: () => 0 });
  const job = e.preparePost(slug, "tradera");
  await until(() => e.get(job.id).state === "needs_login");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].closed, true);
});

test("publish on a non-ready job throws", async () => {
  const { browsers } = fakeBrowsers();
  const g = gate();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { gate: g.wait }) }, browsers, pace: () => 0 });
  const job = e.preparePost(slug, "tradera");
  assert.throws(() => e.publish(job.id), JobStateError);
  await until(() => e.get(job.id).state === "running");
  assert.throws(() => e.publish(job.id), JobStateError);
  g.open();
  await until(() => e.get(job.id).state === "ready_to_publish");
  await e.cancel(job.id);
  assert.throws(() => e.publish(job.id), JobStateError);
});

test("cancel closes the page, running or ready", async () => {
  const { browsers, pages } = fakeBrowsers();
  const g = gate();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { gate: g.wait }) }, browsers, pace: () => 0 });
  const a = e.preparePost(slug, "tradera");
  await until(() => pages.length === 1);
  assert.equal((await e.cancel(a.id)).state, "cancelled");
  assert.equal(pages[0].closed, true);
  g.open();
  const b = e.preparePost(slug, "tradera");
  await until(() => e.get(b.id).state === "ready_to_publish");
  assert.equal(e.get(a.id).state, "cancelled"); // the unwinding runner didn't overwrite it
  await e.cancel(b.id);
  assert.equal(pages[1].closed, true);
  await assert.rejects(e.cancel(b.id), JobStateError);
});

test("one job at a time per platform, platforms in parallel", async () => {
  const { browsers } = fakeBrowsers();
  const t = gate();
  const v = gate();
  const e = createEngine({
    flows: { tradera: fakeFlow("tradera", { gate: t.wait }), vinted: fakeFlow("vinted", { gate: v.wait }) },
    browsers,
    pace: () => 0,
  });
  const t1 = e.preparePost(slug, "tradera");
  const t2 = e.preparePost(slug, "tradera");
  const v1 = e.preparePost(slug, "vinted");
  await until(() => e.get(t1.id).state === "running" && e.get(v1.id).state === "running");
  assert.equal(e.get(t2.id).state, "queued");
  t.open();
  await until(() => e.get(t2.id).state === "ready_to_publish");
  assert.equal(e.get(t1.id).state, "ready_to_publish"); // ready jobs don't hold the queue
  assert.equal(e.get(v1.id).state, "running");
  v.open();
  await until(() => e.get(v1.id).state === "ready_to_publish");
  for (const j of [t1, t2, v1]) await e.cancel(j.id);
});

test("pacing delays the next job on the same platform", async () => {
  const { browsers } = fakeBrowsers();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera") }, browsers, pace: () => 150 });
  const a = e.preparePost(slug, "tradera");
  const b = e.preparePost(slug, "tradera");
  await until(() => e.get(a.id).state === "ready_to_publish");
  const t0 = Date.now();
  await until(() => e.get(b.id).state === "ready_to_publish");
  assert.ok(Date.now() - t0 >= 100);
  for (const j of [a, b]) await e.cancel(j.id);
});

test("waitFor times out with the current state and wakes on change", async () => {
  const { browsers } = fakeBrowsers();
  const g = gate();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { gate: g.wait }) }, browsers, pace: () => 0 });
  const job = e.preparePost(slug, "tradera");
  await until(() => e.get(job.id).state === "running");
  const t0 = Date.now();
  assert.equal((await e.waitFor(job.id, 50)).state, "running");
  assert.ok(Date.now() - t0 < 500);
  const woke = e.waitFor(job.id, 10_000);
  g.open();
  assert.equal((await woke).state, "ready_to_publish");
  const t1 = Date.now();
  assert.equal((await e.waitFor(job.id, 10_000)).state, "ready_to_publish"); // settled: returns at once
  assert.ok(Date.now() - t1 < 100);
  await e.cancel(job.id);
});

test("login completes when isLoggedIn turns true, cancelled when the page closes", async () => {
  const { browsers, pages, log } = fakeBrowsers();
  let loggedIn = false;
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { loggedIn: () => loggedIn }) }, browsers, pace: () => 0, poll: 5 });
  const a = e.login("tradera");
  await until(() => pages.length === 2); // login tab + probe tab
  assert.equal(pages[0].url(), "https://tradera.test/login");
  assert.equal(e.get(a.id).state, "running");
  loggedIn = true;
  pages[0].href = "https://tradera.test/home"; // user finished logging in
  await until(() => e.get(a.id).state === "logged_in");
  assert.ok(pages.every((p) => p.closed));
  // window moved on-screen, then the browser closed once the job let go of it
  assert.deepEqual(log, ["lease tradera", "reveal", "release tradera", "closeUnused tradera leased=0"]);

  loggedIn = false;
  const b = e.login("tradera");
  await until(() => pages.length === 4);
  await pages[2].close(); // user closed the window
  await until(() => e.get(b.id).state === "cancelled");
  await until(() => pages[3].closed);
  assert.equal(log.filter((l) => l.startsWith("closeUnused")).length, 1); // only after logged_in
});

test("a ready_to_publish job keeps its lease until publish or cancel", async () => {
  const { browsers, leased } = fakeBrowsers();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { loggedIn: () => true }) }, browsers, pace: () => 0 });
  const a = e.preparePost(slug, "tradera");
  await until(() => e.get(a.id).state === "ready_to_publish");
  assert.equal(leased(), 1);
  e.publish(a.id);
  await until(() => e.get(a.id).state === "posted");
  assert.equal(leased(), 0);
  const b = e.preparePost("nope", "tradera"); // fails before any page
  await until(() => e.get(b.id).state === "failed");
  assert.equal(leased(), 0);
});

test("reload turns unfinished jobs into expired", async () => {
  const { browsers } = fakeBrowsers();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera") }, browsers, pace: () => 0 });
  const ready = e.preparePost(slug, "tradera");
  await until(() => e.get(ready.id).state === "ready_to_publish");
  const saved = JSON.parse(readFileSync(join(DATA, "jobs.json"), "utf8"));
  assert.equal(saved.find((j: { id: string }) => j.id === ready.id).state, "ready_to_publish");
  const e2 = createEngine({ flows: {}, browsers, pace: () => 0 });
  assert.equal(e2.get(ready.id).state, "expired");
  assert.ok(e2.list().every((j) => ["posted", "logged_in", "failed", "cancelled", "expired"].includes(j.state)));
  await e.cancel(ready.id);
});

test("save keeps unfinished jobs and the newest 200 finished ones from the last 30 days", async () => {
  const t0 = Date.parse("2026-06-01T00:00:00Z");
  const job = (id: string, state: string, ago: number) =>
    ({ id, kind: "post", platform: "tradera", state, createdAt: "", updatedAt: new Date(t0 - ago).toISOString() });
  const done = Array.from({ length: 205 }, (_, i) => job(`d${i}`, "posted", i * 1000));
  writeFileSync(join(DATA, "jobs.json"), JSON.stringify([job("old", "failed", 31 * 86_400_000), ...done]));
  const g = gate();
  const e = createEngine({ flows: { tradera: fakeFlow("tradera", { gate: g.wait }) }, browsers: fakeBrowsers().browsers, now: () => t0, pace: () => 0 });
  const live = e.preparePost(slug, "tradera");
  const ids = JSON.parse(readFileSync(join(DATA, "jobs.json"), "utf8")).map((j: { id: string }) => j.id);
  assert.equal(ids.length, 201);
  assert.ok(ids.includes(live.id) && ids.includes("d199") && !ids.includes("d200") && !ids.includes("old"));
  assert.equal(e.list().length, 201);
  await e.cancel(live.id);
  g.open();
});
