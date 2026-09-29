import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Page } from "patchright";
import sharp from "sharp";
import { FormRejected, type Flow, type Step } from "./platforms/types.ts";

process.env.ADS_DATA_DIR = mkdtempSync(join(tmpdir(), "ads-flow-"));
const { delist, prepare, publish } = await import("./flow.ts");
const { itemDir, loadRecord } = await import("./record.ts");

const slug = "lamp";
const ITEM = `slug: lamp
created: "2026-01-01"
status: ready
item: { type: lamp, condition: good }
price: { sek: 100, negotiable: false }
location: Stockholm
shipping: false
photos: [photos/1.jpg]
ad: { sv: { title: Lampa, description: En lampa }, en: { title: Lamp, description: A lamp } }
platforms: { tradera: { category: Lampor, mode: fixed } }
`;

beforeEach(async () => {
  mkdirSync(join(itemDir(slug), "photos"), { recursive: true });
  writeFileSync(join(itemDir(slug), "item.yaml"), ITEM);
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).jpeg().toFile(join(itemDir(slug), "photos/1.jpg"));
});

const page = {
  screenshot: async ({ path }: { path: string }) => writeFileSync(path, ""),
  waitForTimeout: async () => {},
  url: () => "https://example.test/form",
  locator: () => ({ ariaSnapshot: async () => "- body" }),
  close: async () => {},
} as unknown as Page;
const newPage = async () => page;

function fakeFlow(throwAt?: string, err: Error = new Error("boom"), formErrors: string[] = []) {
  const calls: string[] = [];
  const step = (name: string): Step => ({
    name,
    run: async (_page, ctx) => {
      calls.push(name);
      if (name === throwAt) throw err;
      if (name === "capture_url") ctx.result = { url: "https://example.test/ad/1", id: "1" };
    },
  });
  const flow: Flow = {
    platform: "tradera",
    version: 3,
    loginUrl: "",
    maxPhotos: 1,
    formErrors: async () => formErrors,
    post: ["fill", "submit", "capture_url"].map(step),
    delist: ["mark_sold"].map(step),
  };
  return { flow, calls };
}

const listing = () => loadRecord(slug).listings.tradera;

test("ready → publish → posted", async () => {
  const { flow, calls } = fakeFlow();
  const r = await prepare(flow, slug, newPage);
  assert.equal(r.kind, "ready");
  if (r.kind !== "ready") return;
  assert.deepEqual(calls, ["fill"]);
  assert.ok(existsSync(r.screenshot));
  assert.equal(listing(), undefined);
  assert.deepEqual(await publish(r.handle), { kind: "posted", url: "https://example.test/ad/1", id: "1" });
  assert.deepEqual(calls, ["fill", "submit", "capture_url"]);
  assert.equal(listing()?.status, "posted");
  assert.equal(listing()?.url, "https://example.test/ad/1");
  assert.equal(listing()?.flow_version, 3);
});

test("already posted short-circuits without opening a page", async () => {
  const { flow, calls } = fakeFlow();
  const r = await prepare(flow, slug, newPage);
  assert.equal(r.kind, "ready");
  if (r.kind === "ready") await publish(r.handle);
  const again = await prepare(flow, slug, async () => assert.fail("page opened"));
  assert.deepEqual(again, { kind: "already_posted", url: "https://example.test/ad/1" });
  assert.equal(calls.length, 3);
});

test("failure before submit → failed with dump", async () => {
  const { flow } = fakeFlow("fill");
  const r = await prepare(flow, slug, newPage);
  assert.equal(r.kind, "failed");
  if (r.kind !== "failed") return;
  assert.equal(r.step, "fill");
  assert.match(readFileSync(join(r.dir, "error.txt"), "utf8"), /step: fill\nurl: https:\/\/example.test\/form/);
  assert.equal(readFileSync(join(r.dir, "aria.txt"), "utf8"), "- body");
  assert.equal(listing()?.status, "failed");
  assert.equal(listing()?.failed_step, "fill");
});

test("form errors → failed at validate", async () => {
  const { flow, calls } = fakeFlow(undefined, undefined, ["Price required"]);
  const r = await prepare(flow, slug, newPage);
  assert.equal(r.kind, "failed");
  if (r.kind !== "failed") return;
  assert.equal(r.step, "validate");
  assert.ok(r.error instanceof FormRejected);
  assert.deepEqual(calls, ["fill"]);
  assert.equal(listing()?.status, "failed");
});

test("failure after submit stays submitted and blocks a rerun", async () => {
  const { flow } = fakeFlow("capture_url");
  const r = await prepare(flow, slug, newPage);
  if (r.kind !== "ready") return assert.fail(r.kind);
  const posted = await publish(r.handle);
  assert.equal(posted.kind, "failed");
  assert.equal(listing()?.status, "submitted");
  assert.equal(listing()?.failed_step, "capture_url");
  assert.deepEqual(await prepare(flow, slug, newPage), { kind: "blocked", reason: "submitted" });
  assert.equal((await prepare(flow, slug, newPage, { dryRun: true })).kind, "ready");
});

test("FormRejected after submit → failed", async () => {
  const { flow } = fakeFlow("submit", new FormRejected("Title too long"));
  const r = await prepare(flow, slug, newPage);
  if (r.kind !== "ready") return assert.fail(r.kind);
  const posted = await publish(r.handle);
  assert.equal(posted.kind, "failed");
  assert.equal(listing()?.status, "failed");
  assert.equal(listing()?.failed_step, "submit");
});

test("delist a posted listing → sold, url kept", async () => {
  const { flow, calls } = fakeFlow();
  const r = await prepare(flow, slug, newPage);
  if (r.kind !== "ready") return assert.fail(r.kind);
  await publish(r.handle);
  assert.deepEqual(await delist(flow, slug, newPage, "sold"), { kind: "delisted" });
  assert.deepEqual(calls.slice(-1), ["mark_sold"]);
  assert.equal(listing()?.status, "sold");
  assert.equal(listing()?.url, "https://example.test/ad/1");
  assert.deepEqual(await delist(flow, slug, async () => assert.fail("page opened")), { kind: "not_posted" });
});

test("delist failure keeps the listing posted, with dump", async () => {
  const { flow } = fakeFlow("mark_sold");
  const r = await prepare(flow, slug, newPage);
  if (r.kind !== "ready") return assert.fail(r.kind);
  await publish(r.handle);
  const d = await delist(flow, slug, newPage);
  if (d.kind !== "failed") return assert.fail(d.kind);
  assert.equal(d.step, "mark_sold");
  assert.ok(existsSync(join(d.dir, "error.txt")));
  assert.equal(listing()?.status, "posted");
});
