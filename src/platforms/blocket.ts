import type { Page } from "patchright";
import { configPath } from "../config.ts";
import { log } from "../log.ts";
import type { Ctx, Flow } from "./types.ts";

// Recorded 2026-09-11. Form is a web-component app (shadow DOM): role/label locators only.
const SEL = {
  startUrl: "https://www.blocket.se/create-item/start",
  torgetCard: "[data-recommerce-card]", // "Torget" — clicking creates a server-side draft
  formUrl: /\/recommerce\/create\/\d+/,
  mainCategory: "Huvudkategori",
  subCategory: "Underkategori",
  condition: "Skick",
  productCategory: "Produktkategori",
  colour: "Färg",
  material: "Material",
  fit: "Passform",
  size: "Storlek",
  brand: "Varumärke",
  title: "Annonsrubrik",
  description: "Beskrivning",
  price: "Pris",
  postcode: "Postnummer",
  fileInput: "input[type=file]",
  photoCaption: "Bildtext", // one per uploaded photo
  continue: "Fortsätt",
  deliveryUrl: /\/recommerce\/delivery\//,
  packageHeading: { small: "Litet", medium: "Medium", large: "Stor", xl: "Extra stort" },
  noShipping: "Jag kan inte skicka varan",
  productsUrl: /\/recommerce\/choose-products/,
  freePackage: "Bas",
  publish: "Publicera annonsen",
  receiptUrl: /\/ad-receipt\?.*adId=(\d+)/, // lands here after publish; ad is then in review
  adUrl: (id: string) => `https://www.blocket.se/${id}`, // public URL once approved
  // delist, recorded 2026-09-29
  manageUrl: (id: string) => `https://www.blocket.se/my-items/details/${id}`, // "Hantera annons", owner view
  manageHeading: "Hantera annons",
  markSold: "Markera som såld", // marks it at once, then goes to an optional buyer-review picker
  unmarkSold: "Ta bort såld-märke", // shown once the ad is marked sold
};

const CONDITION = {
  new_with_tags: "Nytt skick - helt ny",
  new: "Nytt skick - helt ny",
  like_new: "Mycket bra skick - som ny",
  good: "Bra skick - varsamt använd",
  fair: "Okej skick - synligt använd",
  poor: "Funkar inte - kan fixas",
};

// getByLabel resolves to the <w-select>/<w-textfield> host; the native control is in its shadow root.
const field = (page: Page, label: string, role: "combobox" | "textbox") => page.getByLabel(label).getByRole(role);

// Clothing/shoe-only selects. Absent elsewhere, and never worth failing a post over, so a miss
// logs what the form actually offered and moves on.
async function pickOption(page: Page, label: string, value: string | undefined) {
  const sel = field(page, label, "combobox");
  if (!(await sel.isVisible({ timeout: 2_000 }).catch(() => false))) return;
  const options = (await sel.getByRole("option").allTextContents()).map((o) => o.trim()).filter(Boolean);
  if (value && options.includes(value)) return sel.selectOption({ label: value });
  log(`blocket: ${label} left blank${value ? ` ("${value}" not offered)` : ""} — options: ${options.join(" | ")}`);
}

// Same fields, but type-and-pick rather than a select. Free text is not accepted.
async function pickSuggestion(page: Page, label: string, value: string | undefined) {
  const combo = field(page, label, "combobox");
  if (!value || !(await combo.isVisible({ timeout: 2_000 }).catch(() => false))) return;
  await combo.getByRole("textbox").fill(value);
  await page.waitForTimeout(1_000);
  // No "first option" fallback: getByRole("option") also matches the native <select>s on the page,
  // and clicking one of those hangs. An exact hit or nothing.
  const exact = page.getByRole("option", { name: value, exact: true });
  if (await exact.count()) return exact.first().click();
  log(`blocket: ${label} "${value}" matched no suggestion, left blank`);
}

// The same field is a select in some categories and an autocomplete in others (Material: autocomplete
// for clothing, select for shoes, seen 2026-09-26), so pick by what the combobox contains.
async function pick(page: Page, label: string, value: string | undefined) {
  const combo = field(page, label, "combobox");
  if (!(await combo.isVisible({ timeout: 2_000 }).catch(() => false))) return;
  if (await combo.getByRole("textbox").count()) return pickSuggestion(page, label, value);
  return pickOption(page, label, value);
}

// Package-size cards on the delivery page: hidden <w-radio aria-labelledby=<h3 id>> next to a heading.
async function pickCard(page: Page, heading: string) {
  const id = await page.getByRole("heading", { name: heading, exact: true }).getAttribute("id");
  await page.locator(`w-radio[aria-labelledby="${id}"]`).click();
}

export const blocket: Flow = {
  platform: "blocket",
  version: 6,
  loginUrl: "https://www.blocket.se/",
  maxPhotos: 10, // unverified; form said "fem eller fler bilder säljer snabbare"
  // unverified against live site
  isLoggedIn: async (page) => {
    await page.goto(SEL.startUrl, { waitUntil: "domcontentloaded" }); // draft is only created by the card click
    return !/login|auth/.test(page.url());
  },
  post: [
    {
      name: "open_form",
      run: async (page) => {
        await page.goto(SEL.startUrl, { waitUntil: "domcontentloaded" });
        if (/login|auth/.test(page.url())) throw new Error("not logged in — run `pnpm run login blocket`");
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {}); // card click is JS-handled; clicking before hydration does nothing
        await page.locator(SEL.torgetCard).click();
        await page.waitForURL(SEL.formUrl);
        // Lit app hydrates after navigation; selects reset until then. networkidle never fires when a
        // background request keeps polling (seen 2026-09-12), so give up after 10 s and continue.
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      },
    },
    {
      name: "category",
      run: async (page, ctx) => {
        const [main, sub] = ctx.record.platforms.blocket!.category.split(" / ");
        await field(page, SEL.mainCategory, "combobox").selectOption({ label: main });
        await field(page, SEL.subCategory, "combobox").selectOption({ label: sub });
      },
    },
    {
      name: "details",
      run: async (page, ctx) => {
        const b = ctx.record.platforms.blocket!;
        await pick(page, SEL.productCategory, b.product_category);
        await pick(page, SEL.colour, b.colour);
        await pick(page, SEL.fit, b.fit);
        await pick(page, SEL.material, b.material);
        await pick(page, SEL.size, b.size); // label match is substring, so this also finds "Skostorlek"
        await pick(page, SEL.brand, ctx.record.item.brand);
      },
    },
    {
      name: "condition",
      run: async (page, ctx) => {
        // Clothing categories have no "Skick" select; they ask for Produktkategori/Färg/Storlek/Varumärke instead.
        const sel = field(page, SEL.condition, "combobox");
        if (!(await sel.isVisible({ timeout: 5_000 }).catch(() => false))) return log("blocket: no Skick field in this category, skipping");
        await sel.selectOption({ label: CONDITION[ctx.record.item.condition] });
      },
    },
    { name: "title", run: (page, ctx) => field(page, SEL.title, "textbox").fill(ctx.title) },
    { name: "description", run: (page, ctx) => field(page, SEL.description, "textbox").fill(ctx.description) },
    { name: "price", run: (page, ctx) => page.getByLabel(SEL.price).fill(String(ctx.record.price.sek)) },
    {
      name: "location",
      run: async (page, ctx) => {
        if (!ctx.config.postcode) throw new Error(`blocket needs postcode in ${configPath()}`);
        const pn = page.getByLabel(SEL.postcode);
        await pn.fill(ctx.config.postcode);
        await pn.press("Tab"); // validation runs on blur
      },
    },
    {
      name: "photos",
      run: async (page, ctx) => {
        await page.locator(SEL.fileInput).setInputFiles(ctx.photos);
        await page.getByRole("textbox", { name: SEL.photoCaption }).nth(ctx.photos.length - 1).waitFor({ timeout: 60_000 });
      },
    },
    {
      name: "shipping",
      run: async (page, ctx) => {
        await page.getByRole("button", { name: SEL.continue }).click();
        await page.waitForURL(SEL.deliveryUrl);
        const pkg = ctx.record.platforms.blocket!.package;
        if (ctx.record.shipping && !pkg) throw new Error("shipping: true needs platforms.blocket.package");
        await pickCard(page, ctx.record.shipping ? SEL.packageHeading[pkg!] : SEL.noShipping);
        await page.getByRole("button", { name: SEL.continue }).click();
        await page.waitForURL(SEL.productsUrl);
      },
    },
    {
      name: "package",
      // Bas/Plus/Premium: <div><w-radio hidden/><h3>Bas</h3>…</div> — the heading has no id, click its parent
      run: (page) => page.getByRole("heading", { name: SEL.freePackage, exact: true }).locator("..").click(),
    },
    {
      name: "submit",
      run: async (page) => {
        await page.getByRole("button", { name: SEL.publish }).click();
        await page.waitForURL(SEL.receiptUrl, { timeout: 60_000 });
      },
    },
    {
      name: "capture_url",
      run: async (page, ctx: Ctx) => {
        ctx.result.id = page.url().match(SEL.receiptUrl)![1];
        ctx.result.url = SEL.adUrl(ctx.result.id);
      },
    },
  ],
  delist: [
    {
      name: "mark_sold",
      run: async (page, ctx) => {
        const manage = SEL.manageUrl(ctx.record.listings.blocket!.id!);
        await page.goto(manage, { waitUntil: "commit" });
        await page.getByRole("heading", { name: SEL.manageHeading }).waitFor();
        if (await page.getByRole("button", { name: SEL.unmarkSold }).count()) return; // already sold
        await page.getByRole("button", { name: SEL.markSold }).click();
        await page.waitForURL((u) => !u.pathname.startsWith("/my-items/details/"));
        await page.goto(manage, { waitUntil: "commit" });
        await page.getByRole("button", { name: SEL.unmarkSold }).waitFor();
      },
    },
  ],
};
