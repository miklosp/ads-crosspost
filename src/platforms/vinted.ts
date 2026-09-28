import type { Page } from "patchright";
import { FormRejected, type Flow } from "./types.ts";

// Recorded 2026-09-12 (English UI). Shipping-only marketplace: buyer pays postage, no pickup option.
// Role names are substring-matched by default; "Brand" also matches "Search brands", hence exact: true.
const SEL = {
  formUrl: "https://www.vinted.se/items/new",
  fileInput: "input[type=file]",
  photoApi: "/api/v2/photos", // one response per uploaded file
  title: "Title",
  description: "Description",
  category: "Category",
  categorySearch: "Find a category", // present only while the picker is open
  categoryBack: "Go back",
  brand: "Brand",
  brandSearch: "Search brands",
  brandCustom: /^Use "/, // radio offered when the search has no match
  authenticityClose: /^(OK, )?close$/i, // originality dialog some brands (Osprey, Calvin Klein) trigger after picking the brand
  size: "Size", // only for categories that have sizes; checkbox list like colours
  condition: "Condition",
  colours: "Colours", // required; checkbox cells inside a group, toggled by clicking the label text
  price: /^Price/, // name grows once a value is set ("Price Bundle discounts are now off…")
  parcel: { small: /Small For items/, medium: /Medium For items/, large: /Large For items/ },
  upload: "Upload",
  itemUrl: /\/items\/(\d+)/,
  itemLink: (title: string) => `a[href*="/items/"][title^="${title.replace(/"/g, '\\"')}"]`, // member page after upload; title attr = "<title>, brand: …"
};

const CONDITION = {
  new_with_tags: /^New with tags/,
  new: /^New without tags/,
  like_new: /^Very good/,
  good: /^Good/,
  fair: /^Satisfactory/,
  poor: /^Satisfactory/,
};

// Vinted shows field errors as role=alert inside <main> ("Fill in size to continue", "Title contains too many
// capital letters…"). An empty live-region alert always sits outside <main>; ignore it.
const formErrors = async (page: Page) =>
  (await page.getByRole("main").getByRole("alert").allTextContents()).map((t) => t.trim()).filter(Boolean);

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Scale pill for a size label: "US 8" → "US", "EU 40" → "EU", a bare "L" → "S/M/L".
const sizeScale = (size: string) => (/^(EU|UK|FR|IT|US) /.test(size) ? size.slice(0, 2) : "S/M/L");

// Category picker: branches are buttons, leaves are radios; a suggestions group sits beside the full list,
// so scope to the list item that holds the picker's search box.
const picker = (page: Page) => page.getByRole("listitem").filter({ has: page.getByRole("textbox", { name: SEL.categorySearch }) });

export const vinted: Flow = {
  platform: "vinted",
  version: 7,
  loginUrl: "https://www.vinted.se/",
  maxPhotos: 20,
  formErrors,
  post: [
    {
      name: "open_form",
      run: async (page, ctx) => {
        if (!ctx.record.shipping) throw new Error("Vinted is shipping-only; record has shipping: false");
        await page.goto(SEL.formUrl, { waitUntil: "domcontentloaded" });
        if (/\/login|\/signup|member\/signup/.test(page.url())) throw new Error("not logged in — run `pnpm run login vinted`");
        await page.getByRole("textbox", { name: SEL.title, exact: true }).waitFor();
      },
    },
    {
      name: "photos",
      run: async (page, ctx) => {
        const uploads = ctx.photos.map(() => page.waitForResponse((r) => r.url().includes(SEL.photoApi) && r.ok(), { timeout: 60_000 }));
        await page.locator(SEL.fileInput).setInputFiles(ctx.photos);
        await Promise.all(uploads);
        await page.waitForTimeout(3_000); // category/attribute suggestions re-render the form after upload
      },
    },
    { name: "title", run: (page, ctx) => page.getByRole("textbox", { name: SEL.title, exact: true }).fill(ctx.title) },
    { name: "description", run: (page, ctx) => page.getByRole("textbox", { name: SEL.description, exact: true }).fill(ctx.description) },
    {
      name: "category",
      run: async (page, ctx) => {
        const path = ctx.record.platforms.vinted!.category.split(" / ");
        await page.keyboard.press("Escape"); // close any dropdown a restored draft left open
        await page.getByRole("textbox", { name: SEL.category, exact: true }).click();
        const p = picker(page);
        const back = p.getByRole("button", { name: SEL.categoryBack, exact: true });
        for (let i = 0; i < 6 && (await back.count()); i++) await back.click();
        for (const name of path.slice(0, -1)) await p.getByRole("button", { name, exact: true }).click();
        await p.getByRole("radio", { name: path.at(-1)!, exact: true }).click();
        await page.getByRole("textbox", { name: SEL.brand, exact: true }).waitFor();
      },
    },
    {
      name: "brand",
      run: async (page, ctx) => {
        const brand = ctx.record.item.brand;
        if (!brand) return; // unverified whether Vinted accepts no brand
        await page.getByRole("textbox", { name: SEL.brand, exact: true }).click();
        await page.getByRole("textbox", { name: SEL.brandSearch }).fill(brand);
        await page.waitForTimeout(1_500);
        const group = page.getByRole("group", { name: SEL.brand });
        // Vinted keeps its own capitalisation ("icebreaker"), and exact: true is case-sensitive.
        const exact = group.getByRole("radio", { name: new RegExp(`^${escapeRx(brand)}$`, "i") });
        const custom = group.getByRole("radio", { name: SEL.brandCustom });
        // A sole match can auto-select and close the list, leaving neither radio on screen.
        if (await exact.count()) await exact.click();
        else if (await custom.count()) await custom.click();
        else console.log(`vinted: brand list gone after typing "${brand}" — assuming it auto-selected`);
        const close = page.getByRole("dialog").getByRole("button", { name: SEL.authenticityClose }).first();
        if (await close.isVisible({ timeout: 1_500 }).catch(() => false)) await close.click();
      },
    },
    {
      name: "size",
      run: async (page, ctx) => {
        const size = ctx.record.platforms.vinted!.size;
        if (!size) return;
        await page.getByRole("textbox", { name: SEL.size, exact: true }).click();
        // Clothes and shoes put a scale row above the grid and remember a per-category default,
        // so "US 8" is not on screen until the US pill is picked. Watches have no row.
        const scale = page.getByText(sizeScale(size), { exact: true });
        if (await scale.isVisible({ timeout: 1_500 }).catch(() => false)) await scale.click();
        // A "Suggested" row repeats a size from the full grid below it, same option either way.
        await page.getByRole("checkbox", { name: size, exact: true }).first().click();
        await page.keyboard.press("Escape");
      },
    },
    {
      name: "condition",
      run: async (page, ctx) => {
        await page.getByRole("textbox", { name: SEL.condition, exact: true }).click();
        await page.getByRole("radio", { name: CONDITION[ctx.record.item.condition] }).click();
      },
    },
    {
      name: "colours",
      run: async (page, ctx) => {
        await page.getByRole("textbox", { name: SEL.colours, exact: true }).click();
        const group = page.getByRole("group", { name: SEL.colours });
        for (const c of ctx.record.platforms.vinted!.colours) await group.getByText(c, { exact: true }).click();
        await page.keyboard.press("Escape");
      },
    },
    {
      name: "price",
      run: async (page, ctx) => {
        const price = page.getByRole("textbox", { name: SEL.price });
        await price.click();
        await price.pressSequentially(String(ctx.record.price.sek)); // masked "0,00 kr" input; fill() doesn't register
      },
    },
    {
      name: "shipping",
      run: async (page, ctx) => {
        const size = ctx.record.platforms.vinted!.package;
        if (!size) throw new Error("platforms.vinted.package is required");
        await page.getByRole("radio", { name: SEL.parcel[size] }).check({ force: true });
      },
    },
    {
      name: "submit",
      run: async (page) => {
        await page.getByRole("button", { name: SEL.upload, exact: true }).click();
        // Either the page leaves the form (posted) or validation messages appear (nothing was published).
        const left = page.waitForURL((u) => !u.pathname.endsWith("/items/new"), { timeout: 60_000 }).then(() => true);
        const refused = page.getByRole("main").getByRole("alert").filter({ hasText: /\S/ }).first().waitFor({ timeout: 60_000 }).then(() => false);
        if (!(await Promise.race([left, refused.catch(() => new Promise<never>(() => {}))]))) throw new FormRejected((await formErrors(page)).join("; "));
      },
    },
    {
      name: "capture_url",
      run: async (page, ctx) => {
        // lands on the seller's member page; the new item is linked there by title
        const href = await page.locator(SEL.itemLink(ctx.title)).first().getAttribute("href");
        ctx.result.id = href!.match(SEL.itemUrl)![1];
        ctx.result.url = `https://www.vinted.se/items/${ctx.result.id}`;
      },
    },
  ],
  delist: [],
};
