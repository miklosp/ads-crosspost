import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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
const browsers = { get: async () => ({ newPage: async () => new FakePage() as unknown as Page }) as unknown as BrowserContext };
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
  delist: [],
};

let mcp: Awaited<ReturnType<typeof startMcpServer>>;
let client: Client;
before(async () => {
  mcp = await startMcpServer({ engine: createEngine({ flows: { tradera: flow }, browsers, pace: () => 0 }), port: 0 });
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
  for (const n of ["list_items", "get_item", "create_item", "update_item", "add_photos", "search_categories", "get_category_fields",
    "search_options", "login", "prepare_post", "get_status", "wait_for_status", "publish", "cancel", "list_jobs"])
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

  const tool = (await client.listTools()).tools.find((t) => t.name === "publish")!;
  assert.equal(tool.annotations?.destructiveHint, true);
  await call("publish", { job_id: job.id });
  r = await call("wait_for_status", { job_id: job.id, max_s: 5 });
  assert.equal(json(r).state, "posted");
  assert.equal(loadRecord("lamp").listings.tradera?.status, "posted");
  assert.equal(json(await call("list_items"))[0].listings.tradera.status, "posted");
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
