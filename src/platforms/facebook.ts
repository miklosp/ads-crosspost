import { log } from "../log.ts";
import type { Flow } from "./types.ts";

// Recorded 2026-09-11 (English UI). React form; role/name locators.
// Currency follows the account's Marketplace home location, not the listing — set that to Stockholm once.
const SEL = {
  formUrl: "https://www.facebook.com/marketplace/create/item",
  fileInput: "input[type=file]", // two exist; first is the photo picker
  saveDraft: "Save draft", // disabled until the upload has actually finished
  photoStatus: (n: number) => new RegExp(`^${n} photos? attached$`),
  title: "Title",
  price: "Price",
  category: "Category",
  categoryMenu: "Dropdown menu",
  condition: "Condition",
  moreDetails: /^More details/, // toggles; check aria-expanded first
  description: "Description",
  tags: /^Product tags/, // chip input under More details; type, then Enter
  monthlyLimit: /reached your monthly limit/, // 20 listings/month; the form still loads but Next stays disabled (seen 2026-09-26)
  next: "Next", // first match; the second is the preview carousel arrow
  audienceUrl: /step=audience/,
  publish: "Publish",
  sellingUrl: "https://www.facebook.com/marketplace/you/selling",
  promoteLink: (title: string) => new RegExp(`^Promote now for ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  itemId: /target_id=(\d+)/, // the listing id, exposed only in the "Promote now" href
};

const CONDITION = {
  new_with_tags: "New",
  new: "New",
  like_new: "Used - Like New",
  good: "Used - Good",
  fair: "Used - Fair",
  poor: "Used - Fair",
};

export const facebook: Flow = {
  platform: "facebook",
  version: 5,
  loginUrl: "https://www.facebook.com/marketplace/",
  maxPhotos: 10,
  // unverified against live site
  isLoggedIn: async (page) => {
    await page.goto(SEL.formUrl, { waitUntil: "domcontentloaded" });
    return !/\/login/.test(page.url());
  },
  post: [
    {
      name: "open_form",
      run: async (page) => {
        await page.goto(SEL.formUrl, { waitUntil: "domcontentloaded" });
        if (/\/login/.test(page.url())) throw new Error("not logged in — run `pnpm run login facebook`");
        await page.getByRole("textbox", { name: SEL.title }).waitFor();
        if (await page.getByRole("heading", { name: SEL.monthlyLimit }).count()) throw new Error("facebook monthly listing limit reached — retry on or after the 1st");
      },
    },
    {
      name: "photos",
      run: async (page, ctx) => {
        await page.locator(SEL.fileInput).first().setInputFiles(ctx.photos);
        const draft = page.getByRole("button", { name: SEL.saveDraft });
        for (let i = 0; i < 60 && (await draft.isDisabled()); i++) await page.waitForTimeout(1000);
        await page.waitForTimeout(1500); // form re-renders once more after the upload settles
        await page.getByRole("status").filter({ hasText: SEL.photoStatus(ctx.photos.length) }).waitFor();
      },
    },
    { name: "title", run: (page, ctx) => page.getByRole("textbox", { name: SEL.title }).fill(ctx.title) },
    { name: "price", run: (page, ctx) => page.getByRole("textbox", { name: SEL.price }).fill(String(ctx.record.price.sek)) },
    {
      name: "category",
      run: async (page, ctx) => {
        await page.getByRole("combobox", { name: SEL.category }).click();
        await page
          .getByRole("dialog", { name: SEL.categoryMenu })
          .getByRole("button", { name: new RegExp(`^${ctx.record.platforms.facebook!.category}`) })
          .click();
      },
    },
    {
      name: "condition",
      run: async (page, ctx) => {
        await page.getByRole("combobox", { name: SEL.condition }).click();
        await page.getByRole("option", { name: CONDITION[ctx.record.item.condition], exact: true }).click();
      },
    },
    {
      name: "description",
      run: async (page, ctx) => {
        const more = page.getByRole("button", { name: SEL.moreDetails });
        if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
        await page.getByRole("textbox", { name: SEL.description }).fill(ctx.description);
      },
    },
    {
      name: "tags",
      run: async (page, ctx) => {
        const tags = ctx.record.platforms.facebook!.tags;
        if (!tags?.length) return;
        const box = page.getByRole("textbox", { name: SEL.tags });
        if (!(await box.isVisible({ timeout: 2_000 }).catch(() => false))) return log("facebook: no Product tags field, skipping");
        for (const tag of tags) {
          await box.fill(tag);
          await page.keyboard.press("Enter");
        }
      },
    },
    {
      name: "audience",
      run: async (page) => {
        await page.getByRole("button", { name: SEL.next, exact: true }).first().click();
        await page.waitForURL(SEL.audienceUrl);
      },
    },
    {
      name: "submit",
      run: async (page) => {
        await page.getByRole("button", { name: SEL.publish, exact: true }).click();
        await page.waitForURL((u) => !u.pathname.includes("/marketplace/create/"), { timeout: 60_000 });
      },
    },
    {
      name: "capture_url",
      run: async (page, ctx) => {
        // "Your listings" has no item links; the id is in each row's "Promote now" href.
        await page.goto(SEL.sellingUrl, { waitUntil: "domcontentloaded" });
        const href = await page.getByRole("link", { name: SEL.promoteLink(ctx.title) }).first().getAttribute("href");
        ctx.result.id = href!.match(SEL.itemId)![1];
        ctx.result.url = `https://www.facebook.com/marketplace/item/${ctx.result.id}/`;
      },
    },
  ],
  delist: [],
};
