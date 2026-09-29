import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import type { createEngine, Job } from "./jobs.ts";
import { createRecord, DATA, itemDir, loadRecord, PLATFORMS, RecordSchema, ROOT, updateRecord, type PlatformName } from "./record.ts";
import { inboxDir, loadConfig } from "./config.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { importPhoto, isHeic } from "./photos.ts";
import { claudeDir, hostPath, inInbox } from "./photos-paths.ts";

type Engine = ReturnType<typeof createEngine>;
type Content = CallToolResult["content"];

const CONF = join(DATA, "mcp.json");
const PHOTO = /\.(jpe?g|png|hei[cf])$/i;
const Platform = z.enum(PLATFORMS as [PlatformName, ...PlatformName[]]);
const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("item slug, lowercase kebab-case");

const text = (v: unknown): Content[number] => ({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) });
const ok = (...content: Content): CallToolResult => ({ content });
const jpeg = (buf: Buffer): Content[number] => ({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });

// word match: every whitespace-separated query word is a case-insensitive substring
const matcher = (query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (s: string) => words.every((w) => s.toLowerCase().includes(w));
};
const snapshot = <T>(p: PlatformName, kind: "categories" | "fields"): T =>
  JSON.parse(readFileSync(join(ROOT, "src", "platforms", `${p}.${kind}.json`), "utf8"));
type Fields = {
  fields: { [k: string]: { label: string; type: string; options?: string[] } };
  categories: { [path: string]: { required: string[]; optional: string[] } };
};

async function jobResult(job: Job): Promise<CallToolResult> {
  const out: Content = [text(job)];
  if (job.state === "ready_to_publish" && job.screenshot) {
    // ≤1280px wide, <1MB: shrink quality, then width, until it fits
    for (const [width, quality] of [[1280, 80], [1280, 60], [1024, 50], [800, 40]]) {
      const buf = await sharp(job.screenshot).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
      if (buf.length < 1_000_000 || width === 800) {
        out.push(jpeg(buf), text(`Screenshot of the filled form. Show this screenshot to the user (display the image, don't just describe it). ` +
          `It's also saved at ${job.screenshot} and shown in the Ads Crosspost window under Review, where the user can publish too. ` +
          `Get explicit approval before calling publish.`));
        break;
      }
    }
  }
  if (job.state === "failed" && job.dir && existsSync(join(job.dir, "aria.txt"))) {
    const aria = readFileSync(join(job.dir, "aria.txt"), "utf8").split("\n").slice(0, 60).join("\n");
    out.push(text(`Failed at step "${job.step}": ${job.error}\nRun dir: ${job.dir}\naria.txt (first 60 lines):\n${aria}`));
  }
  return { content: out };
}

const PROMPT = readFileSync(join(ROOT, "src", "prompts", "post_ad.md"), "utf8");
const photosIn = (folder?: string) => (folder ? `\nPhotos are in: ${folder}\n` : "");
const FIRST = "If you haven't called start_ad in this conversation, call it first. ";

function buildServer(engine: Engine, claude: string) {
  const s = new McpServer({ name: "ads-crosspost", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true };

  s.registerTool("start_ad", {
    description: "Call this first, before any other ads-crosspost tool, at the start of every new ad. Returns the workflow and the rules for writing and posting ads.",
    inputSchema: { folder: z.string().optional().describe("folder with the item's photos") },
    annotations: ro,
  }, async ({ folder }) => ok(text(INSTRUCTIONS + "\n\n" + PROMPT + photosIn(folder))));

  s.registerTool("list_items", { description: FIRST + "List all items with status and per-platform listing status.", annotations: ro }, async () => {
    const dir = join(DATA, "items");
    const slugs = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "item.yaml"))) : [];
    return ok(text(slugs.map((slug) => {
      try {
        const r = loadRecord(slug);
        return { slug, title: r.ad.sv.title, status: r.status, platforms: Object.keys(r.platforms), listings: r.listings };
      } catch (e) {
        return { slug, error: e instanceof Error ? e.message : String(e) };
      }
    })));
  });

  s.registerTool("get_item", { description: FIRST + "Full item record, including listings (status/url per platform).", inputSchema: { slug: Slug }, annotations: ro },
    async ({ slug }) => ok(text(loadRecord(slug))));

  s.registerTool("create_item", {
    description: FIRST + "Create items/<slug>/item.yaml. Call add_photos(slug) first; `photos` are the relative paths it returned. " +
      "Ad text in Swedish (sv) and English (en); titles ≤60 chars, at most 8 capital letters; description 3–8 short lines, no price/location/shipping. " +
      "Pick categories and field values only from search_categories / get_category_fields / search_options. A platforms key present = post there. Fails if the slug exists.",
    inputSchema: { fields: RecordSchema.omit({ created: true, listings: true }) },
  }, async ({ fields }) => {
    const missing = fields.photos.filter((p) => !existsSync(join(itemDir(fields.slug), p)));
    if (missing.length) throw new Error(`photos not found in items/${fields.slug}/: ${missing.join(", ")}; call add_photos first`);
    createRecord({ ...fields, created: new Date().toISOString().slice(0, 10), listings: {} });
    return ok(text(`created items/${fields.slug}/item.yaml`), text({ slug: fields.slug }));
  });

  s.registerTool("update_item", {
    description: FIRST + "Patch an item record (JSON merge patch: objects merge, arrays and scalars replace, null deletes a key, e.g. {platforms: {vinted: null}}). " +
      "Result is validated against the record schema. `slug` and `listings` cannot be changed.",
    inputSchema: { slug: Slug, patch: z.record(z.string(), z.unknown()) },
  }, async ({ slug, patch }) => {
    if ("slug" in patch || "listings" in patch) throw new Error("slug and listings cannot be patched");
    return ok(text(updateRecord(slug, patch)));
  });

  s.registerTool("add_photos", {
    description: FIRST + "Copy photos (jpg/jpeg/png/heic; HEIC is converted to JPEG) from a folder or explicit file paths into items/<slug>/photos/ and return thumbnails so you can see them. " +
      "With neither folder nor paths, imports every photo in the user's inbox folder (name order) and then moves the originals to <inbox>/imported/<slug>/. " +
      "In a Cowork VM, pass the /sessions/... paths you see (attached inbox folder or files dropped in the chat) as-is; they are mapped to host paths. " +
      "Works before create_item. If the item exists, the photos are appended to its record.",
    inputSchema: {
      slug: Slug,
      folder: z.string().optional().describe("absolute folder path; its photo files are copied in name order"),
      paths: z.array(z.string()).optional().describe("absolute file paths"),
    },
  }, async ({ slug, folder, paths }) => {
    const roots = { inbox: inboxDir(loadConfig()), claude };
    const notes: string[] = [];
    const host = (p: string) => {
      const r = hostPath(p, roots);
      if (r.note) notes.push(r.note);
      return resolve(r.path);
    };
    const dirPath = folder ? host(folder) : paths?.length ? undefined : roots.inbox;
    if (dirPath === roots.inbox) mkdirSync(dirPath, { recursive: true });
    const src = dirPath ? readdirSync(dirPath).filter((f) => PHOTO.test(f)).sort().map((f) => join(dirPath, f)) : (paths ?? []).map(host);
    if (!src.length) throw new Error(`no jpg/jpeg/png/heic files given${dirPath === roots.inbox ? ` and the inbox (${roots.inbox}) is empty` : ""}`);
    const bad = src.filter((p) => !PHOTO.test(p) || !existsSync(p));
    if (bad.length) throw new Error(`not a photo or missing: ${bad.join(", ")}`);
    const dir = join(itemDir(slug), "photos");
    mkdirSync(dir, { recursive: true });
    let n = readdirSync(dir).length;
    const added = [];
    for (const from of src) {
      const rel = `photos/${String(++n).padStart(2, "0")}${isHeic(from) ? ".jpg" : extname(from).toLowerCase()}`;
      await importPhoto(from, join(itemDir(slug), rel));
      added.push({ from: basename(from), rel });
    }
    if (existsSync(join(itemDir(slug), "item.yaml")))
      updateRecord(slug, { photos: [...loadRecord(slug).photos, ...added.map((a) => a.rel)] });
    const done = join(roots.inbox, "imported", slug);
    for (const from of src.filter((p) => inInbox(p, roots.inbox))) {
      mkdirSync(done, { recursive: true });
      let to = join(done, basename(from));
      for (let i = 2; existsSync(to); i++) to = join(done, `${i}-${basename(from)}`);
      renameSync(from, to);
      notes.push(`moved ${basename(from)} to ${to}`);
    }
    const out: Content = [text(`Copied into items/${slug}/:\n${added.map((a) => `${a.rel} (from ${a.from})`).join("\n")}${notes.length ? `\n\n${notes.join("\n")}` : ""}`)];
    for (const a of added)
      await sharp(join(itemDir(slug), a.rel)).rotate().resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 70 }).toBuffer()
        .then((b) => out.push(text(a.rel), jpeg(b)))
        .catch((e) => out.push(text(`${a.rel}: no thumbnail (${e.message})`)));
    return { content: out };
  });

  s.registerTool("search_categories", {
    description: FIRST + "Search a platform's category taxonomy (case-insensitive, all words must match). Returns ≤20 full category paths to use verbatim.",
    inputSchema: { platform: Platform, query: z.string() },
    annotations: ro,
  }, async ({ platform, query }) => {
    const hits = snapshot<string[]>(platform, "categories").filter(matcher(query));
    return ok(text(hits.slice(0, 20)), text(`${hits.length} matches${hits.length > 20 ? ", showing 20; refine the query" : ""}`));
  });

  s.registerTool("get_category_fields", {
    description: FIRST + "Required and optional form fields for a category (exact path from search_categories), with labels and allowed options. Long option lists are truncated; use search_options.",
    inputSchema: { platform: Platform, category: z.string() },
    annotations: ro,
  }, async ({ platform, category }) => {
    const snap = snapshot<Fields>(platform, "fields");
    const c = snap.categories[category];
    if (!c) throw new Error(`no category "${category}" in ${platform} snapshot; use search_categories`);
    const describe = (k: string) => {
      const { options, ...f } = snap.fields[k] ?? { label: k, type: "unknown" };
      if (!options) return { key: k, ...f };
      if (options.length <= 30) return { key: k, ...f, options };
      return { key: k, ...f, options: options.slice(0, 30), note: `${options.length} options; use search_options(platform, "${k}", query)` };
    };
    return ok(text({ required: c.required.map(describe), optional: c.optional.map(describe) }));
  });

  s.registerTool("search_options", {
    description: FIRST + "Search the allowed options of one field (key from get_category_fields). Case-insensitive, all words must match; ≤30 results.",
    inputSchema: { platform: Platform, field: z.string(), query: z.string() },
    annotations: ro,
  }, async ({ platform, field, query }) => {
    const f = snapshot<Fields>(platform, "fields").fields[field];
    if (!f) throw new Error(`no field "${field}" in ${platform} snapshot`);
    const hits = (f.options ?? []).filter(matcher(query));
    return ok(text(hits.slice(0, 30)), text(`${hits.length} matches`));
  });

  s.registerTool("login", {
    description: FIRST + "Open a browser window on the platform's login page for the user to log in. Returns a job at once; poll with wait_for_status until logged_in.",
    inputSchema: { platform: Platform },
  }, async ({ platform }) => ok(text(engine.login(platform))));

  s.registerTool("prepare_post", {
    description: FIRST + "Fill the platform's listing form for an item in a browser, without submitting. Returns a job at once; poll with wait_for_status. " +
      "At ready_to_publish you get a screenshot to show the user. needs_login → call login.",
    inputSchema: { slug: Slug, platform: Platform },
  }, async ({ slug, platform }) => ok(text(engine.preparePost(slug, platform))));

  s.registerTool("get_status", { description: FIRST + "Current state of a job (with screenshot when ready_to_publish, error details when failed).", inputSchema: { job_id: z.string() }, annotations: ro },
    async ({ job_id }) => jobResult(engine.get(job_id)));

  s.registerTool("wait_for_status", {
    description: FIRST + "Wait until a job changes state (or is already settled), up to max_s seconds. Same result as get_status. Call repeatedly while queued/running/publishing.",
    inputSchema: { job_id: z.string(), max_s: z.number().min(0).max(45).default(30) },
    annotations: ro,
  }, async ({ job_id, max_s }) => jobResult(await engine.waitFor(job_id, max_s * 1000)));

  s.registerTool("publish", {
    description: FIRST + "Submit a ready_to_publish job's filled form, making the ad public. Call ONLY after the user has seen the screenshot and explicitly approved publishing. Then poll with wait_for_status until posted.",
    inputSchema: { job_id: z.string() },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ job_id }) => ok(text(engine.publish(job_id))));

  s.registerTool("mark_sold", {
    description: FIRST + "The item has sold: set its status to sold and end every live listing (marked sold where the site allows, else hidden or ended). " +
      "`on` is the platform it sold on, if any. Returns one delist job per live listing; poll each with wait_for_status until delisted. " +
      "Call ONLY after the user has said the item sold.",
    inputSchema: { slug: Slug, on: Platform.optional() },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ slug, on }) => ok(text(engine.sold(slug, on))));

  s.registerTool("delist", {
    description: FIRST + "End one live listing without marking the item sold (e.g. the user withdraws it from one site). Returns a job; poll with wait_for_status until delisted. " +
      "Call ONLY after the user asked for it.",
    inputSchema: { slug: Slug, platform: Platform },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ slug, platform }) => ok(text(engine.delist(slug, platform))));

  s.registerTool("cancel", { description: FIRST + "Cancel a job and close its browser page; a filled form is abandoned.", inputSchema: { job_id: z.string() } },
    async ({ job_id }) => ok(text(await engine.cancel(job_id))));

  s.registerPrompt("post_ad", {
    description: "Interview the user about an item, write the ad in Swedish and English, save it and post it with approval.",
    argsSchema: { folder: z.string().optional().describe("folder with the item's photos") },
  }, ({ folder }) => ({
    messages: [{ role: "user", content: { type: "text", text: PROMPT + photosIn(folder) } }],
  }));

  s.registerTool("list_jobs", { description: FIRST + "All jobs, newest last.", annotations: ro }, async () => ok(text(engine.list())));

  return s;
}

type Conf = { token: string; port: number };

const listen = (srv: Server, port: number, host: string) =>
  new Promise<number>((res, rej) => {
    srv.once("error", rej);
    srv.listen(port, host, () => {
      srv.off("error", rej);
      res((srv.address() as AddressInfo).port);
    });
  });

// Streamable HTTP, stateless (a fresh McpServer per request), on 127.0.0.1 only. Token and port persist in
// <DATA>/mcp.json (0600) so configured hosts keep working across restarts.
// `claude`: Claude Desktop's config dir, where Cowork uploads are looked up (tests pass a fake one).
export async function startMcpServer({ engine, port, host = "127.0.0.1", claude = claudeDir(homedir()) }:
  { engine: Engine; port?: number; host?: string; claude?: string }) {
  const saved: Partial<Conf> = existsSync(CONF) ? JSON.parse(readFileSync(CONF, "utf8")) : {};
  const token = saved.token ?? randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let actual = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const deny = (code: number, msg: string) => res.writeHead(code, { "content-type": "text/plain" }).end(msg);
    const origin = req.headers.origin;
    if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host ?? "") || (origin !== undefined && origin !== "null"))
      return deny(403, "forbidden");
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny(401, "unauthorized");
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return deny(404, "not found");
    if (req.method !== "POST") return deny(405, "method not allowed"); // stateless: no GET stream, no DELETE
    const server = buildServer(engine, claude);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const srv = createServer((req, res) => void handle(req, res).catch((e) => res.headersSent || res.writeHead(500).end(String(e))));
  const want = port ?? saved.port ?? 0;
  try {
    actual = await listen(srv, want, host);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || port !== undefined) throw e;
    actual = await listen(srv, 0, host); // persisted port taken: pick a new one
  }
  if (saved.token !== token || saved.port !== actual) writeFileSync(CONF, JSON.stringify({ token, port: actual } satisfies Conf), { mode: 0o600 });

  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    token,
    close: () =>
      new Promise<void>((res) => {
        srv.close(() => res());
        srv.closeAllConnections();
      }),
  };
}
