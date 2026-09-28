import type { Page } from "patchright";
import type { Flow } from "./types.ts";

// Recorded 2026-09-12. React form; dropdowns are role=menu whose accessible name is "<label> <current value>".
// Uploading photos first triggers Tradera's AI autofill (title, description, category, condition, shipping);
// every later step overwrites what it guessed.
const SEL = {
  newUrl: "https://www.tradera.com/selling/new", // redirects to /selling/draft/<id>
  draftUrl: /\/selling\/draft\//,
  englishUrl: /tradera\.com\/en(\/|$)/, // the site sometimes flips the account to English; selectors below are Swedish
  homeUrl: "https://www.tradera.com/",
  languageMenu: "Language", // footer Radix menu, opens on hover
  swedish: "Swedish",
  interstitial: "Skapa en som vanligt", // "Flera annonser i ett svep" promo, seen once
  consentAgree: "#didomi-notice-agree-button", // Didomi cookie banner; reappears when consent expires and blocks every click (seen 2026-09-26)
  fileInput: "input[type=file]",
  tipDialogOk: "Ok, då vet jag", // "Autofyllda annonser" tip after first upload, seen once
  photoStepContinue: "Fortsätt",
  title: "Rubrik",
  description: "#tip-tap-editor", // TipTap contenteditable; fill() keeps newlines as paragraphs
  categoryMenu: /^Kategori/,
  categorySearch: /^Sök kategori/,
  categoryBack: "Tillbaka", // inside the breadcrumb nav when the menu opens below root
  categoryDone: (path: string) => `Kategori ${path}`,
  conditionMenu: /^Skick/,
  conditionEmpty: /^Skick Välj skick/, // Tradera can clear the pick after the category change (seen 2026-09-26)
  formatMenu: /^Annonsformat/,
  fixedFormat: "Köp nu",
  fixedPrice: "Köp nu-pris",
  shippingBox: "#offerShippingByWeight",
  shippingEdit: "Ändra", // reopens the size dialog when shipping is already on (autofill)
  shippingIntroContinue: "Fortsätt", // "Nu är frakt ännu smidigare" intro, seen once
  sizeDialog: "Ange varans storlek",
  sizeLabel: { small: /^Small/, medium: /^Medium/, large: /^Large/ },
  sizeSave: "Spara",
  pickupBox: "#offerTakeaway",
  confirmBox: "#publishAutoFillCheckbox", // "Jag intygar att annonsens innehåll är korrekt"
  publish: "Publicera",
  itemUrl: /\/item\/\d+\/(\d+)/,
  listingsUrl: "https://www.tradera.com/my/listings",
};

const CONDITION = {
  new_with_tags: /^Oanvänt/,
  new: /^Oanvänt/,
  like_new: /^Mycket gott skick/,
  good: /^Gott använt skick/,
  fair: /^Okej använt skick/,
  poor: /^Defekt/,
};

async function pickCondition(page: Page, condition: keyof typeof CONDITION) {
  await page.getByRole("menu", { name: SEL.conditionMenu }).click();
  // listed twice when autofill already picked it (under "Förslag" and "Alla"); re-picking the
  // selected value doesn't close the menu, so close it by hand
  const item = page.getByRole("menuitem", { name: CONDITION[condition] });
  await item.first().click();
  if (await item.first().isVisible()) await page.keyboard.press("Escape");
}

const clickIfPresent = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click({ timeout: 5_000 }).catch(() => {});

export const tradera: Flow = {
  platform: "tradera",
  version: 9,
  loginUrl: "https://www.tradera.com/",
  maxPhotos: 12, // unverified
  // unverified against live site
  isLoggedIn: async (page) => {
    await page.goto(SEL.listingsUrl, { waitUntil: "domcontentloaded" }); // not newUrl: that creates a draft
    return !/\/login|\/signin/.test(page.url());
  },
  post: [
    {
      name: "open_form",
      run: async (page) => {
        await page.goto(SEL.newUrl, { waitUntil: "domcontentloaded" });
        if (/\/login|\/signin/.test(page.url())) throw new Error("not logged in — run `pnpm run login tradera`");
        if (SEL.englishUrl.test(page.url())) {
          await page.goto(SEL.homeUrl, { waitUntil: "domcontentloaded" }); // the menu only opens reliably on the start page
          const menu = page.getByRole("button", { name: SEL.languageMenu, exact: true });
          const swedish = page.getByRole("button", { name: SEL.swedish, exact: true });
          // infinite scroll keeps pushing the footer down, so the first hover often misses
          for (let i = 0; i < 5 && !(await swedish.isVisible()); i++) {
            await menu.scrollIntoViewIfNeeded();
            await menu.hover();
            await page.waitForTimeout(1_500);
          }
          await swedish.click();
          await page.waitForURL((u) => !SEL.englishUrl.test(u.href));
          await page.goto(SEL.newUrl, { waitUntil: "domcontentloaded" });
        }
        await page.waitForURL(SEL.draftUrl);
        await page.locator(SEL.consentAgree).click({ timeout: 5_000 }).catch(() => {});
        await clickIfPresent(page, SEL.interstitial);
        await page.getByRole("textbox", { name: SEL.title }).waitFor();
      },
    },
    {
      name: "photos",
      run: async (page, ctx) => {
        await page.locator(SEL.fileInput).first().setInputFiles(ctx.photos);
        await page.getByRole("dialog").getByRole("button", { name: SEL.tipDialogOk }).click({ timeout: 8_000 }).catch(() => {});
        // sometimes the form collapses to a photo step; continuing runs the autofill and brings the fields back
        await clickIfPresent(page, SEL.photoStepContinue);
        await page.getByRole("textbox", { name: SEL.title }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(3_000); // autofill keeps writing for a moment
      },
    },
    { name: "title", run: (page, ctx) => page.getByRole("textbox", { name: SEL.title }).fill(ctx.title) },
    { name: "description", run: (page, ctx) => page.locator(SEL.description).fill(ctx.description) },
    {
      name: "category",
      run: async (page, ctx) => {
        const path = ctx.record.platforms.tradera!.category;
        if (await page.getByRole("menu", { name: SEL.categoryDone(path) }).count()) return; // autofill already picked it (seen 2026-09-12)
        await page.getByRole("menu", { name: SEL.categoryMenu }).click();
        await page.getByRole("textbox", { name: SEL.categorySearch }).waitFor();
        const back = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: SEL.categoryBack });
        for (let i = 0; i < 5 && (await back.count()); i++) await back.click();
        for (const name of path.split(" / ")) await page.getByRole("menuitem", { name, exact: true }).click();
        await page.getByRole("menu", { name: SEL.categoryDone(path) }).waitFor();
      },
    },
    {
      name: "condition",
      run: (page, ctx) => pickCondition(page, ctx.record.item.condition),
    },
    {
      name: "price",
      run: async (page, ctx) => {
        if (ctx.record.platforms.tradera!.mode !== "fixed") throw new Error("tradera auction flow not recorded");
        await page.getByRole("menu", { name: SEL.formatMenu }).click();
        await page.getByRole("menuitem", { name: SEL.fixedFormat, exact: true }).click();
        await page.getByRole("textbox", { name: SEL.fixedPrice }).fill(String(ctx.record.price.sek));
      },
    },
    {
      name: "shipping",
      run: async (page, ctx) => {
        const { weight, package: size } = ctx.record.platforms.tradera!;
        const box = page.locator(SEL.shippingBox);
        if (ctx.record.shipping) {
          if (!weight || !size) throw new Error("shipping: true needs platforms.tradera.weight and .package");
          if (await box.isChecked()) await page.getByRole("button", { name: SEL.shippingEdit, exact: true }).first().click();
          else await box.click({ force: true });
          await clickIfPresent(page, SEL.shippingIntroContinue);
          const dlg = page.getByRole("dialog", { name: SEL.sizeDialog });
          await dlg.getByRole("radio", { name: weight, exact: true }).check({ force: true });
          await dlg.getByRole("checkbox", { name: SEL.sizeLabel[size] }).check({ force: true });
          await dlg.getByRole("button", { name: SEL.sizeSave }).click();
          await dlg.waitFor({ state: "hidden" });
        } else if (await box.isChecked()) {
          await box.click({ force: true });
        }
        const pickup = page.locator(SEL.pickupBox);
        if (!(await pickup.isChecked())) await pickup.click({ force: true });
      },
    },
    {
      name: "confirm",
      run: async (page, ctx) => {
        if (await page.getByRole("menu", { name: SEL.conditionEmpty }).count()) await pickCondition(page, ctx.record.item.condition);
        const c = page.locator(SEL.confirmBox);
        if (!(await c.count())) return; // only shown when the AI autofill ran (absent 2026-09-26)
        if (!(await c.isChecked())) await c.click({ force: true });
      },
    },
    {
      name: "submit",
      run: async (page) => {
        await page.getByRole("button", { name: SEL.publish, exact: true }).click();
        await page.waitForURL((u) => !SEL.draftUrl.test(u.pathname), { timeout: 60_000 });
      },
    },
    {
      name: "capture_url",
      run: async (page, ctx) => {
        // unverified: where Tradera lands after publish. Fall back to the newest item under "Aktiva annonser".
        if (!SEL.itemUrl.test(page.url())) {
          await page.goto(SEL.listingsUrl, { waitUntil: "domcontentloaded" });
          // match on title: the first link is whichever listing sorts first, not necessarily this one (seen 2026-09-12)
          const href = await page.locator('a[href*="/item/"]', { hasText: ctx.title.slice(0, 40) }).first().getAttribute("href");
          await page.goto(new URL(href!, page.url()).toString());
        }
        ctx.result.url = page.url();
        ctx.result.id = page.url().match(SEL.itemUrl)![1];
      },
    },
  ],
  delist: [],
};
