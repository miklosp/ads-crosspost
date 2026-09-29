import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserContext, Page } from "patchright";
import sharp from "sharp";
import type { Flow } from "./platforms/types.ts";

process.env.ADS_DATA_DIR = mkdtempSync(join(tmpdir(), "ads-mcp-"));
const { createEngine } = await import("./jobs.ts");
const { DATA, loadRecord } = await import("./record.ts");
const { startMcpServer } = await import("./mcp.ts");

class FakePage extends EventEmitter {
  closed = false;
  url = () => "https://tradera.test/";
  isClosed = () => this.closed;
  goto = async () => {};
  bringToFront = async () => {};
  screenshot = async ({ path }: { path: string }) =>
    void (await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#888" } }).png().toFile(path));
  waitForTimeout = async () => {};
  close = async () => void (this.closed = true);
}
const browsers = {
  get: async () => ({ newPage: async () => new FakePage() as unknown as Page }) as unknown as BrowserContext,
  lease: () => () => {},
  closeUnused: async () => {},
  reveal: async () => {},
};
const flow: Flow = {
  platform: "tradera",
  version: 1,
  loginUrl: "https://tradera.test/login",
  maxPhotos: 5,
  post: [
    { name: "fill", run: async () => {} },
    { name: "submit", run: async () => {} },
    { name: "capture_url", run: async (_p, ctx) => void (ctx.result = { url: "https://tradera.test/ad/1" }) },
  ],
  delist: [{ name: "mark_sold", run: async () => {} }],
};

let mcp: Awaited<ReturnType<typeof startMcpServer>>;
let client: Client;
before(async () => {
  mcp = await startMcpServer({ engine: createEngine({ flows: { tradera: flow }, browsers, pace: () => 0 }), port: 0, claude: join(DATA, "Claude") });
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }));
});
after(async () => {
  await client.close();
  await mcp.close();
});

const call = async (name: string, args: object = {}) => {
  const r = (await client.callTool({ name, arguments: { ...args } })) as CallToolResult;
  assert.ok(!r.isError, JSON.stringify(r.content));
  return r;
};
const json = (r: CallToolResult, i = 0) => JSON.parse((r.content[i] as { text: string }).text);

test("token and port persisted 0600", () => {
  const conf = JSON.parse(readFileSync(join(DATA, "mcp.json"), "utf8"));
  assert.equal(conf.token, mcp.token);
  assert.match(conf.token, /^[0-9a-f]{64}$/);
  assert.equal(`http://127.0.0.1:${conf.port}/mcp`, mcp.url);
  assert.equal(statSync(join(DATA, "mcp.json")).mode & 0o777, 0o600);
});

test("create → prepare → ready with screenshot → publish → posted", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["start_ad", "list_items", "get_item", "create_item", "update_item", "add_photos", "search_categories", "get_category_fields",
    "search_options", "login", "prepare_post", "get_status", "wait_for_status", "publish", "mark_sold", "delist", "cancel", "list_jobs"])
    assert.ok(names.includes(n), n);

  const src = join(DATA, "inbox");
  mkdirSync(src);
  await sharp({ create: { width: 900, height: 600, channels: 3, background: "#123" } }).jpeg().toFile(join(src, "a.jpg"));
  await sharp({ create: { width: 900, height: 600, channels: 3, background: "#321" } }).png().toFile(join(src, "b.png"));
  const added = await call("add_photos", { slug: "lamp", folder: src });
  assert.equal(added.content.filter((c) => c.type === "image").length, 2);

  const cat = json(await call("search_categories", { platform: "tradera", query: "lampor" }));
  assert.ok(cat.length > 0 && cat.length <= 20);

  await call("create_item", {
    fields: {
      slug: "lamp",
      status: "ready",
      item: { type: "lamp", condition: "good" },
      price: { sek: 100, negotiable: false },
      location: "Stockholm",
      shipping: false,
      photos: ["photos/01.jpg", "photos/02.png"],
      ad: { sv: { title: "Lampa", description: "En lampa" }, en: { title: "Lamp", description: "A lamp" } },
      platforms: { tradera: { category: cat[0], mode: "fixed" } },
    },
  });
  await call("update_item", { slug: "lamp", patch: { price: { sek: 150 } } });
  const rec = loadRecord("lamp");
  assert.equal(rec.price.sek, 150);
  assert.equal(rec.price.negotiable, false);
  const bad = (await client.callTool({ name: "update_item", arguments: { slug: "lamp", patch: { price: { sek: "x" } } } })) as CallToolResult;
  assert.ok(bad.isError);

  const job = json(await call("prepare_post", { slug: "lamp", platform: "tradera" }));
  let r = await call("wait_for_status", { job_id: job.id, max_s: 5 });
  for (let i = 0; i < 5 && json(r).state !== "ready_to_publish"; i++) r = await call("wait_for_status", { job_id: job.id, max_s: 5 });
  assert.equal(json(r).state, "ready_to_publish");
  const imgs = r.content.filter((c) => c.type === "image");
  assert.equal(imgs.length, 1);
  const meta = await sharp(Buffer.from((imgs[0] as { data: string }).data, "base64")).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(meta.width! <= 1280);
  const note = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  assert.ok(note.includes(json(r).screenshot), "screenshot path");
  assert.match(note, /display the image[\s\S]*under Review/);

  const tool = (await client.listTools()).tools.find((t) => t.name === "publish")!;
  assert.equal(tool.annotations?.destructiveHint, true);
  await call("publish", { job_id: job.id });
  r = await call("wait_for_status", { job_id: job.id, max_s: 5 });
  assert.equal(json(r).state, "posted");
  assert.equal(loadRecord("lamp").listings.tradera?.status, "posted");
  assert.equal(json(await call("list_items"))[0].listings.tradera.status, "posted");

  const tools = (await client.listTools()).tools;
  for (const n of ["mark_sold", "delist"]) assert.equal(tools.find((t) => t.name === n)?.annotations?.destructiveHint, true, n);
  const [d] = json(await call("mark_sold", { slug: "lamp", on: "tradera" }));
  r = await call("wait_for_status", { job_id: d.id, max_s: 5 });
  for (let i = 0; i < 5 && json(r).state !== "delisted"; i++) r = await call("wait_for_status", { job_id: d.id, max_s: 5 });
  assert.equal(json(r).state, "delisted");
  assert.equal(loadRecord("lamp").status, "sold");
  assert.equal(loadRecord("lamp").listings.tradera?.status, "sold");
});

test("add_photos converts HEIC to upright JPEG", async () => {
  // fixture: `sips -s format heic` of a 64x32 red|blue JPEG with EXIF orientation 6 (stored as irot)
  const r = await call("add_photos", { slug: "heic", paths: [join(import.meta.dirname, "fixtures", "rotated.heic")] });
  assert.equal(r.content.filter((c) => c.type === "image").length, 1);
  assert.deepEqual(readdirSync(join(DATA, "items", "heic", "photos")), ["01.jpg"]);
  const img = sharp(join(DATA, "items", "heic", "photos", "01.jpg"));
  const meta = await img.metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["jpeg", 32, 64, undefined]);
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 200 && data[2] < 50, "top is red");
});

test("add_photos without paths imports the inbox and moves originals to imported/<slug>/; VM paths are mapped", async () => {
  const inbox = join(DATA, "My Inbox");
  writeFileSync(join(DATA, "config.yaml"), `inbox: ${JSON.stringify(inbox)}\n`);
  const img = (p: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: "#456" } }).jpeg().toFile(p);
  mkdirSync(join(inbox, "imported", "old"), { recursive: true });
  for (const f of ["b.jpg", "a.jpg", "imported/old/z.jpg"]) await img(join(inbox, f));
  writeFileSync(join(inbox, "notes.txt"), "");

  const r = await call("add_photos", { slug: "chair" });
  assert.match((r.content[0] as { text: string }).text, /01\.jpg \(from a\.jpg\)\n.*02\.jpg \(from b\.jpg\)[\s\S]*moved a\.jpg/);
  assert.deepEqual(readdirSync(join(DATA, "items", "chair", "photos")), ["01.jpg", "02.jpg"]);
  assert.deepEqual(readdirSync(inbox).sort(), ["imported", "notes.txt"]);
  assert.deepEqual(readdirSync(join(inbox, "imported", "chair")), ["a.jpg", "b.jpg"]);
  assert.deepEqual(readdirSync(join(inbox, "imported", "old")), ["z.jpg"]);

  // attached inbox (moved) + a chat upload (left in place)
  await img(join(inbox, "c.jpg"));
  const up = join(DATA, "Claude", "local-agent-mode-sessions", "acct", "org", "s1", "uploads");
  mkdirSync(up, { recursive: true });
  await img(join(up, "IMG_9.jpg"));
  await call("add_photos", { slug: "chair", paths: ["/sessions/x/mnt/My Inbox/c.jpg", "/sessions/x/mnt/uploads/IMG_9.jpg"] });
  assert.deepEqual(readdirSync(join(DATA, "items", "chair", "photos")), ["01.jpg", "02.jpg", "03.jpg", "04.jpg"]);
  assert.deepEqual(readdirSync(join(inbox, "imported", "chair")), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.deepEqual(readdirSync(up), ["IMG_9.jpg"]);

  const bad = (await client.callTool({ name: "add_photos", arguments: { slug: "chair", paths: ["/sessions/x/mnt/Desktop/a.jpg"] } })) as CallToolResult;
  assert.ok(bad.isError);
  assert.match((bad.content[0] as { text: string }).text, /attach the inbox folder/);
  const empty = (await client.callTool({ name: "add_photos", arguments: { slug: "chair" } })) as CallToolResult;
  assert.match((empty.content[0] as { text: string }).text, /inbox .* is empty/);
  rmSync(join(DATA, "config.yaml"));
});

test("instructions, start_ad and post_ad prompt", async () => {
  assert.match(client.getInstructions() ?? "", /start_ad[\s\S]*publish/);
  const { tools } = await client.listTools();
  for (const t of tools.filter((t) => t.name !== "start_ad")) assert.match(t.description ?? "", /start_ad/, t.name);
  assert.equal(tools.find((t) => t.name === "start_ad")?.annotations?.readOnlyHint, true);
  const rules = ((await call("start_ad", { folder: "/tmp/photos" })).content[0] as { text: string }).text;
  assert.match(rules, /Workflow per item/);
  assert.match(rules, /Pick the slug first: lowercase kebab/);
  assert.match(rules, /Photos are in: \/tmp\/photos/);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["post_ad"]);
  assert.equal(prompts[0].arguments?.[0]?.name, "folder");
  const r = await client.getPrompt({ name: "post_ad", arguments: { folder: "/tmp/photos" } });
  const t = (r.messages[0].content as { text: string }).text;
  assert.match(t, /search_categories/);
  assert.match(t, /Photos are in: \/tmp\/photos/);
});

test("rejects missing token, foreign Origin, foreign Host", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const auth = { ...headers, authorization: `Bearer ${mcp.token}` };
  assert.equal((await fetch(mcp.url, { method: "POST", headers, body })).status, 401);
  assert.equal((await fetch(mcp.url, { method: "POST", headers: { ...auth, authorization: "Bearer nope" }, body })).status, 401);
  assert.equal((await fetch(mcp.url, { method: "POST", headers: { ...auth, origin: "https://evil.test" }, body })).status, 403);
  // fetch won't override Host, so use node:http
  const { request } = await import("node:http");
  const status = await new Promise<number>((res, rej) => {
    const u = new URL(mcp.url);
    request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "POST", headers: { ...auth, host: `evil.test:${u.port}` } }, (r) => res(r.statusCode!))
      .on("error", rej)
      .end(body);
  });
  assert.equal(status, 403);
});

test("reuses token and persisted port; moves off a taken port", async () => {
  const engine = createEngine({ flows: {}, browsers, pace: () => 0 });
  const b = await startMcpServer({ engine }); // persisted port is held by `mcp`
  assert.equal(b.token, mcp.token);
  assert.notEqual(b.url, mcp.url);
  await b.close();
  const c = await startMcpServer({ engine });
  assert.equal(c.url, b.url);
  await c.close();
});
