import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "patchright";
import type { browserManager } from "./browsers.ts";
import { delist, prepare, publish, type Handle } from "./flow.ts";
import type { Flow } from "./platforms/types.ts";
import { DATA, markSold, type PlatformName } from "./record.ts";

export type JobState =
  | "queued" | "running" | "needs_login" | "ready_to_publish" | "publishing"
  | "posted" | "logged_in" | "delisted" | "failed" | "cancelled" | "expired";
export type Job = {
  id: string;
  kind: "login" | "post" | "delist";
  slug?: string;
  platform: PlatformName;
  state: JobState;
  step?: string;
  error?: string;
  dir?: string;
  screenshot?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
};

const TERMINAL: JobState[] = ["posted", "logged_in", "delisted", "failed", "cancelled", "expired"];
const SETTLED: JobState[] = [...TERMINAL, "needs_login", "ready_to_publish"]; // waitFor returns at once
const FILE = join(DATA, "jobs.json");
const KEEP_MS = 30 * 86_400_000; // finished jobs older than this are dropped on save
const KEEP_MAX = 200; // and at most this many finished jobs are kept

export class JobStateError extends Error {}

type Opts = {
  flows: Partial<Record<PlatformName, Flow>>;
  browsers: Pick<ReturnType<typeof browserManager>, "get" | "lease" | "closeUnused" | "reveal">;
  now?: () => number;
  pace?: () => number; // ms between the end of one job and the start of the next prepare on a platform
  poll?: number; // ms between login checks
};

// In-process job queue driven by the MCP server and the desktop UI. Browser work is serialised per
// platform; a ready_to_publish job keeps its page open but does not hold the queue. A job with a page leases
// its platform's browser, so the idle close (browsers.ts) never closes it under the job.
export function createEngine({ flows, browsers, now = Date.now, pace = () => 20_000 + Math.random() * 40_000, poll = 3000 }: Opts) {
  const events = new EventEmitter<{ change: [Job] }>();
  const jobs = new Map<string, Job>();
  const pages = new Map<string, Page>();
  const releases = new Map<string, () => void>();
  const handles = new Map<string, Handle>();
  const tails = new Map<PlatformName, Promise<void>>();
  const lastEnd = new Map<PlatformName, number>();

  // pages are lost across restarts, so anything unfinished can't resume
  if (existsSync(FILE))
    for (const j of JSON.parse(readFileSync(FILE, "utf8")) as Job[])
      jobs.set(j.id, TERMINAL.includes(j.state) ? j : { ...j, state: "expired" });
  const save = () => {
    const done = [...jobs.values()].filter((j) => TERMINAL.includes(j.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    done.forEach((j, i) => (i >= KEEP_MAX || now() - Date.parse(j.updatedAt) > KEEP_MS) && jobs.delete(j.id));
    writeFileSync(FILE, JSON.stringify([...jobs.values()], null, 2));
  };
  save();

  const stamp = () => new Date(now()).toISOString();
  const must = (id: string) => {
    const j = jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  };
  const flowOf = (p: PlatformName) => {
    const f = flows[p];
    if (!f) throw new Error(`no flow for "${p}"`);
    return f;
  };

  const update = (job: Job, patch: Partial<Job>) => {
    if (job.state === "cancelled") return; // a cancelled job's runner may still be unwinding
    Object.assign(job, patch, { updatedAt: stamp() });
    save();
    events.emit("change", { ...job });
  };

  const create = (kind: Job["kind"], platform: PlatformName, slug?: string) => {
    const t = stamp();
    const job: Job = { id: randomUUID().slice(0, 8), kind, slug, platform, state: "queued", createdAt: t, updatedAt: t };
    jobs.set(job.id, job);
    save();
    events.emit("change", { ...job });
    return job;
  };

  const closePage = async (id: string) => {
    const page = pages.get(id);
    pages.delete(id);
    handles.delete(id);
    await page?.close().catch(() => {});
    releases.get(id)?.();
    releases.delete(id);
  };

  const enqueue = (job: Job, run: () => Promise<void>) => {
    const p = job.platform;
    const t = (tails.get(p) ?? Promise.resolve()).then(async () => {
      if (job.state === "cancelled") return;
      try {
        await run();
      } catch (e) {
        update(job, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (job.state !== "ready_to_publish") await closePage(job.id);
        lastEnd.set(p, now());
      }
    });
    tails.set(p, t);
  };

  const newPage = async (job: Job) => {
    if (!releases.has(job.id)) releases.set(job.id, browsers.lease(job.platform));
    const page = await (await browsers.get(job.platform)).newPage();
    pages.set(job.id, page);
    return page;
  };

  function login(platform: PlatformName) {
    const flow = flowOf(platform);
    const job = create("login", platform);
    enqueue(job, async () => {
      update(job, { state: "running" });
      const page = await newPage(job);
      const closed = new Promise<void>((res) => page.once("close", () => res()));
      await browsers.reveal(page); // the user must see it, even if the browser runs hidden
      await page.goto(flow.loginUrl);
      await page.bringToFront();
      // isLoggedIn navigates, so it runs on a separate probe tab, and only when the user's tab has moved
      let probe: Page | undefined;
      let seen = "";
      let ok = false;
      try {
        while (!ok && !page.isClosed()) {
          if (flow.isLoggedIn && page.url() !== seen) {
            seen = page.url();
            probe ??= await (await browsers.get(platform)).newPage();
            ok = await flow.isLoggedIn(probe);
            if (!page.isClosed()) await page.bringToFront();
          }
          if (!ok) await Promise.race([sleep(poll), closed]);
        }
      } finally {
        await probe?.close().catch(() => {});
      }
      if (!ok) return update(job, { state: "cancelled" });
      // close the now on-screen browser; the next job relaunches it per the hide_browsers setting
      await closePage(job.id);
      await browsers.closeUnused(platform);
      update(job, { state: "logged_in" });
    });
    return { ...job };
  }

  // Waits out the platform's pacing, then checks the session. false: the job was cancelled or needs a login.
  async function start(job: Job, flow: Flow) {
    const last = lastEnd.get(flow.platform);
    if (last !== undefined) await sleep(Math.max(0, last + pace() - now()));
    if (job.state === "cancelled") return false;
    update(job, { state: "running" });
    if (!flow.isLoggedIn) return true;
    const ok = await flow.isLoggedIn(await newPage(job));
    await closePage(job.id);
    if (!ok) update(job, { state: "needs_login" });
    return ok;
  }

  function preparePost(slug: string, platform: PlatformName) {
    const flow = flowOf(platform);
    const job = create("post", platform, slug);
    enqueue(job, async () => {
      if (!(await start(job, flow))) return;
      const r = await prepare(flow, slug, () => newPage(job));
      if (r.kind === "ready") {
        handles.set(job.id, r.handle); // dropped by closePage in enqueue if the job was cancelled meanwhile
        update(job, { state: "ready_to_publish", screenshot: r.screenshot });
      } else if (r.kind === "already_posted") update(job, { state: "posted", url: r.url });
      else if (r.kind === "blocked") update(job, { state: "failed", error: r.reason });
      else update(job, { state: "failed", step: r.step, error: r.error instanceof Error ? r.error.message : String(r.error), dir: r.dir });
    });
    return { ...job };
  }

  function delistJob(slug: string, platform: PlatformName, status: "sold" | "delisted" = "delisted") {
    const flow = flowOf(platform);
    const job = create("delist", platform, slug);
    enqueue(job, async () => {
      if (!(await start(job, flow))) return;
      const r = await delist(flow, slug, () => newPage(job), status);
      if (r.kind === "failed") update(job, { state: "failed", step: r.step, error: r.error instanceof Error ? r.error.message : String(r.error), dir: r.dir });
      else update(job, { state: "delisted" });
    });
    return { ...job };
  }

  // Marks the item sold and queues a delist job for every live listing; `on` is the platform it sold on.
  function sold(slug: string, on?: PlatformName) {
    return markSold(slug).map((p) => delistJob(slug, p, p === on ? "sold" : "delisted"));
  }

  function publishJob(id: string) {
    const job = must(id);
    const handle = handles.get(id);
    if (job.state !== "ready_to_publish" || !handle) throw new JobStateError(`job ${id} is ${job.state}, not ready_to_publish`);
    update(job, { state: "publishing" });
    enqueue(job, async () => {
      const r = await publish(handle);
      if (r.kind === "posted") update(job, { state: "posted", url: r.url });
      else update(job, { state: "failed", step: r.step, error: r.error instanceof Error ? r.error.message : String(r.error), dir: r.dir });
    });
    return { ...job };
  }

  async function cancel(id: string) {
    const job = must(id);
    if (TERMINAL.includes(job.state) || job.state === "publishing") throw new JobStateError(`job ${id} is ${job.state}, cannot cancel`);
    update(job, { state: "cancelled" });
    await closePage(id);
    return { ...job };
  }

  // Long-poll: resolves on the next state change, at once if already settled, or after maxMs.
  function waitFor(id: string, maxMs: number) {
    const job = must(id);
    const from = job.state;
    if (SETTLED.includes(from)) return Promise.resolve({ ...job });
    return new Promise<Job>((res) => {
      const done = () => {
        clearTimeout(timer);
        events.off("change", onChange);
        res({ ...job });
      };
      const onChange = (j: Job) => j.id === id && j.state !== from && done();
      const timer = setTimeout(done, maxMs);
      events.on("change", onChange);
    });
  }

  return Object.assign(events, {
    login,
    preparePost,
    publish: publishJob,
    delist: delistJob,
    sold,
    cancel,
    get: (id: string) => ({ ...must(id) }),
    list: () => [...jobs.values()].map((j) => ({ ...j })),
    waitFor,
  });
}
