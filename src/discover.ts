import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "patchright";
import { openBrowser } from "./browser.ts";
import { ROOT, type PlatformName } from "./record.ts";
import { blocket } from "./platforms/blocket.ts";
import { tradera } from "./platforms/tradera.ts";

// Snapshots every category's form fields into src/platforms/<p>.fields.json.
// Read-only: opens the sell form, reads the site's own field-definition endpoints, never saves or publishes.
// Raw responses are cached under .cache/discover/<p>/ so an interrupted crawl resumes; delete it to refresh.

type Field = { label: string; type: string; unit?: string; multi?: boolean; max?: number; options?: string[] };
type Snapshot = {
  platform: PlatformName;
  snapshot: string;
  fields: { [key: string]: Field };
  categories: { [path: string]: { required: string[]; optional: string[] } };
};

// Same field name with different options in different categories gets a "#2", "#3"… key.
function addField(snap: Snapshot, name: string, f: Field) {
  const json = JSON.stringify(f);
  for (let i = 1; ; i++) {
    const key = i === 1 ? name : `${name}#${i}`;
    if (!snap.fields[key]) snap.fields[key] = f;
    if (JSON.stringify(snap.fields[key]) === json) return key;
  }
}

function setCategory(snap: Snapshot, path: string, fields: [key: string, required: boolean][]) {
  snap.categories[path] = {
    required: fields.filter(([, r]) => r).map(([k]) => k),
    optional: fields.filter(([, r]) => !r).map(([k]) => k),
  };
}

const cacheDir = (p: string) => join(ROOT, ".cache", "discover", p);
async function cached<T>(p: string, id: string | number, get: () => Promise<T>): Promise<T> {
  const file = join(cacheDir(p), `${id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const v = await get();
  writeFileSync(file, JSON.stringify(v));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700)); // pace like a person clicking through
  return v;
}

const getJson = (page: Page, url: string, init?: { method: string; body: string; headers: { [h: string]: string } }) =>
  page.evaluate(
    async ([url, init]) => {
      // Tradera 403s without x-requested-with; harmless elsewhere.
      const r = await fetch(url, { ...init, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest", ...init?.headers } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    },
    [url, init] as const,
  );

// Blocket ships the whole form model (every field, with the category ids it applies to) base64-encoded
// in #app[data-config] of the create page. One request covers every category.
async function discoverBlocket(page: Page, snap: Snapshot) {
  await blocket.post[0].run(page, {} as never);
  const html: string = await page.evaluate(() => fetch(location.href).then((r) => r.text()));
  const b64 = html.match(/data-config='([^']+)'/)![1];
  const model: any[] = JSON.parse(Buffer.from(b64, "base64").toString("utf8")).model;

  const tax: { id: number; parentId?: number; label: string; persistable: boolean }[] = model.find((f) => f.name === "category").values;
  const byId = new Map(tax.map((n) => [n.id, n]));
  const ancestry = (n: (typeof tax)[number]) => {
    const chain = [n];
    while (chain[0].parentId) chain.unshift(byId.get(chain[0].parentId)!);
    return chain;
  };
  // Filled by the flow from other inputs or not user-facing; everything else is a form field.
  const skip = /^(address|image|category|trade_type|price\.price_max|tmp_|edited_by_system_tmp)/;
  const fields = model.filter((f) => f.type !== "complexRoot" && !skip.test(f.name));
  for (const n of tax.filter((n) => n.persistable)) {
    const chain = ancestry(n);
    const ids = chain.map((c) => String(c.id));
    const applies = fields.filter((f) => !f.dependencies?.category || f.dependencies.category.some((id: string) => ids.includes(id)));
    setCategory(
      snap,
      chain.map((c) => c.label).join(" / "),
      applies.map((f) => [
        addField(snap, f.name, {
          label: f.label,
          type: f.type,
          ...(f.unit && { unit: f.unit }),
          ...(f.options && { options: f.options.map((o: any) => o.label) }),
        }),
        !!f.mandatory,
      ]),
    );
  }
}

// Tradera: category tree via the picker's suggestion endpoints, then one attributes call per leaf.
async function discoverTradera(page: Page, snap: Snapshot) {
  await tradera.post[0].run(page, {} as never);
  const post = (url: string, body: object) =>
    getJson(page, url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const sv: { [k: string]: string } = await getJson(page, "/api/i18n/translations/sv/attributes");

  type Node = { name: string; categoryId: number; isLeaf: boolean; path: string };
  let level: Node[] = (await post("/api/webclient/categories/suggestions/top-level", { shortDescription: null, languageCodeIso2: "sv" })).categories.map(
    (c: Node) => ({ ...c, path: c.name }),
  );
  const leaves: Node[] = [];
  for (let depth = 2; level.length; depth++) {
    leaves.push(...level.filter((c) => c.isLeaf));
    const parents = level.filter((c) => !c.isLeaf);
    level = [];
    for (let i = 0; i < parents.length; i += 50) {
      const chunk = parents.slice(i, i + 50);
      const res = await post("/api/webclient/categories/suggestions/by-parents", {
        shortDescription: null,
        categoryLevel: depth,
        parentCategoryIds: chunk.map((c) => c.categoryId),
        languageCodeIso2: "sv",
      });
      for (const parent of chunk)
        for (const c of res.categoriesAndSuggestions[parent.categoryId]?.categories ?? []) level.push({ ...c, path: `${parent.path} / ${c.name}` });
    }
  }

  for (const [i, leaf] of leaves.entries()) {
    const id = leaf.categoryId;
    const fetchLeaf = () =>
      Promise.all([
        getJson(page, `/api/webclient/selling/attributes?categoryId=${id}&locale=sv`),
        getJson(page, `/api/webclient/selling/category-restrictions/${id}?languageCodeIso2=sv`),
      ]);
    const [attrs, restr] = await cached("tradera", id, () =>
      // the page's auth token expires every few hundred requests (401); reloading the form renews it
      fetchLeaf().catch(async (e) => {
        if (!String(e).includes("401")) throw e;
        await tradera.post[0].run(page, {} as never);
        return fetchLeaf();
      }),
    );
    const defs: [string, boolean][] = attrs.attributeDefinitions.map((a: any) => [
      addField(snap, a.backingField, {
        label: a.displayName,
        type: a.inputType,
        ...(a.isMultiSelect && { multi: true, max: a.maxNumberOfValues }),
        options: a.possibleValues.map((v: any) => sv[`attribute_af-${a.backingField}_${v.value}`] ?? v.value),
      }),
      a.isRequired,
    ]);
    if (restr.allowUsed === false) defs.push([addField(snap, "new_only", { label: "Only new items allowed", type: "Restriction" }), true]);
    setCategory(snap, leaf.path, defs);
    if (i % 100 === 0) console.log(`tradera ${i}/${leaves.length}`);
  }
}

// Vinted: catalog tree in one call, then the attributes the form asks for per leaf catalog.
async function discoverVinted(page: Page, snap: Snapshot) {
  await page.goto("https://www.vinted.se/items/new", { waitUntil: "domcontentloaded" });
  if (/login|signup/.test(page.url())) throw new Error("not logged in — run `pnpm run login vinted`");
  await page.getByRole("textbox", { name: "Title", exact: true }).waitFor(); // config script streams in after DOMContentLoaded
  // The API 403s without the CSRF token the page embeds in its Next.js config.
  const csrf = (await page.content()).match(/CSRF_TOKEN\\?":\\?"([0-9a-f-]+)/)![1];
  const anon = await page.evaluate(() => document.cookie.match(/anon_id=([^;]+)/)?.[1] ?? "");
  const apiHeaders = { "content-type": "application/json", "x-csrf-token": csrf, "x-anon-id": anon };

  type Cat = { id: number; title: string; catalogs: Cat[] };
  const roots: Cat[] = (await getJson(page, "/api/v2/item_upload/catalogs")).catalogs;
  const leaves: { id: number; path: string }[] = [];
  const walk = (c: Cat, prefix: string) => {
    const path = prefix ? `${prefix} / ${c.title}` : c.title;
    if (!c.catalogs.length) leaves.push({ id: c.id, path });
    for (const k of c.catalogs) walk(k, path);
  };
  roots.forEach((r) => walk(r, ""));

  const flatten = (opts: any[]): string[] =>
    opts.length === 1 && opts[0].type === "group" // one wrapper group named like the field: drop it
      ? flatten(opts[0].options)
      : opts.flatMap((o) => (o.type === "group" ? flatten(o.options).map((t) => `${o.title} / ${t}`) : [o.title]));
  for (const [i, leaf] of leaves.entries()) {
    const res = await cached("vinted", leaf.id, () =>
      getJson(page, "/api/v2/item_upload/attributes", {
        method: "POST",
        body: JSON.stringify({ attributes: [{ code: "category", value: [leaf.id] }] }),
        headers: apiHeaders,
      }),
    );
    const defs: [string, boolean][] = res.attributes.map((a: any) => {
      const c = a.configuration;
      // No per-category config: brand (search box), color (global list, see /api/v2/item_upload/colors), measurements.
      if (!c) return [addField(snap, a.code, { label: a.code, type: "global" }), false];
      return [
        addField(snap, a.code, {
          label: c.title,
          type: c.display_type,
          ...(c.selection_type === "multi" && { multi: true, max: c.selection_limit }),
          ...(c.options?.length && { options: flatten(c.options) }),
        }),
        !!c.required,
      ];
    });
    setCategory(snap, leaf.path, defs);
    if (i % 100 === 0) console.log(`vinted ${i}/${leaves.length}`);
  }
}

// Facebook: no tree, ~25 flat categories. Pick each in the form and read the attribute definitions query it fires.
async function discoverFacebook(page: Page, snap: Snapshot) {
  await page.goto("https://www.facebook.com/marketplace/create/item", { waitUntil: "domcontentloaded" });
  if (/\/login/.test(page.url())) throw new Error("not logged in — run `pnpm run login facebook`");
  const combo = page.getByRole("combobox", { name: "Category" });
  await combo.click();
  const menu = page.getByRole("dialog", { name: "Dropdown menu" });
  // Vehicles opens a different form; the rest carry an optional "Shipping available" badge in their text.
  const names = (await menu.getByRole("button").allTextContents()).map((s) => s.replace(/Shipping available$/, "").trim()).filter((s) => s && s !== "Vehicles");
  await page.keyboard.press("Escape");
  console.log(`facebook: ${names.join(" | ")}`);
  for (const name of names) {
    const defs = page
      .waitForResponse(async (r) => r.url().includes("/api/graphql") && (await r.text().catch(() => "")).includes('"definitions"'), { timeout: 15_000 })
      .then((r) => r.json())
      .catch(() => null);
    await combo.click();
    await menu.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
    const list: any[] | undefined = (await defs)?.data?.viewer?.definitions;
    if (!list) {
      console.log(`facebook: no field definitions after picking "${name}"`);
      continue;
    }
    setCategory(
      snap,
      name,
      list.map((d) => [
        addField(snap, d.attribute_name, {
          label: d.attribute_name,
          type: d.input_type,
          ...(d.value_label_inputs?.length && { options: d.value_label_inputs.map((v: any) => v.label) }),
        }),
        !!d.is_required,
      ]),
    );
    await page.waitForTimeout(800 + Math.random() * 800);
  }
}

const DISCOVER = { blocket: discoverBlocket, tradera: discoverTradera, vinted: discoverVinted, facebook: discoverFacebook };

export async function discover(p: PlatformName) {
  mkdirSync(cacheDir(p), { recursive: true });
  const snap: Snapshot = { platform: p, snapshot: new Date().toISOString().slice(0, 10), fields: {}, categories: {} };
  const browser = await openBrowser(p);
  const page = browser.pages()[0] ?? (await browser.newPage());
  try {
    await DISCOVER[p](page, snap);
  } finally {
    await browser.close();
  }
  const dir = join(ROOT, "src", "platforms");
  writeFileSync(join(dir, `${p}.fields.json`), JSON.stringify(snap, null, 1) + "\n");
  console.log(`${p}: ${Object.keys(snap.categories).length} categories, ${Object.keys(snap.fields).length} distinct fields → src/platforms/${p}.fields.json`);
}
