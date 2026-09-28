import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export const ROOT = new URL("..", import.meta.url).pathname;
export const itemDir = (slug: string) => join(ROOT, "items", slug);

const Lang = z.enum(["sv", "en", "both"]);
const Condition = z.enum(["new_with_tags", "new", "like_new", "good", "fair", "poor"]);

const Listing = z.object({
  status: z.enum(["submitted", "posted", "failed", "delisted"]),
  url: z.string().optional(),
  id: z.string().optional(),
  posted_at: z.string().optional(),
  flow_version: z.number().optional(),
  failed_step: z.string().optional(),
});

const Ad = z.object({ title: z.string(), description: z.string() });

export const RecordSchema = z.strictObject({
  slug: z.string(),
  created: z.string(),
  status: z.enum(["draft", "ready", "posted", "sold", "delisted"]),
  item: z.strictObject({
    type: z.string(),
    brand: z.string().optional(),
    model: z.string().optional(),
    condition: Condition,
    defects: z.string().optional(),
    included: z.string().optional(),
    age: z.string().optional(),
    dimensions: z.string().optional(),
    reason: z.string().optional(),
  }),
  price: z.strictObject({ sek: z.number(), negotiable: z.boolean() }),
  location: z.string(),
  shipping: z.boolean(),
  photos: z.array(z.string()).min(1),
  ad: z.strictObject({ sv: Ad, en: Ad }),
  platforms: z
    .strictObject({
      blocket: z
        .strictObject({
          category: z.string(), // "Huvudkategori / Underkategori", the site's visible labels
          package: z.enum(["small", "medium", "large", "xl"]).optional(), // required when shipping: true
          // clothing and shoe categories swap the "Skick" select for these four; all optional
          product_category: z.string().optional(), // "Produktkategori" select, options depend on the subcategory
          colour: z.string().optional(), // "Färg" select, Blocket's Swedish label
          material: z.string().optional(), // "Material" autocomplete, revealed by some product categories
          fit: z.string().optional(), // "Passform" select; the form already defaults to "Normal i storleken"
          size: z.string().optional(), // "Storlek" autocomplete
          lang: Lang.optional(),
        })
        .optional(),
      tradera: z
        .strictObject({
          category: z.string(),
          mode: z.enum(["fixed", "auction"]),
          start_sek: z.number().optional(),
          days: z.number().optional(),
          weight: z.string().optional(), // Tradera's label, e.g. "1 kg"; required when shipping: true
          package: z.enum(["small", "medium", "large"]).optional(), // required when shipping: true
          lang: Lang.optional(),
        })
        .optional(),
      vinted: z
        .strictObject({
          category: z.string(), // full path to a leaf, " / "-separated
          package: z.enum(["small", "medium", "large"]), // envelope | shoebox | moving box
          colours: z.array(z.string()).min(1).max(2), // Vinted's English colour names, required
          size: z.string().optional(), // label of the size checkbox; some categories (watches) require it
          lang: Lang.optional(),
        })
        .optional(),
      facebook: z
        .strictObject({
          category: z.string(),
          tags: z.array(z.string()).max(20).optional(), // "Product tags" chips under More details
          lang: Lang.optional(),
        })
        .optional(),
    })
    .default({}),
  listings: z
    .strictObject({
      blocket: Listing.optional(),
      tradera: Listing.optional(),
      vinted: Listing.optional(),
      facebook: Listing.optional(),
    })
    .default({}),
});

export type Record = z.infer<typeof RecordSchema>;
export type PlatformName = keyof Record["platforms"];
export type Listing = z.infer<typeof Listing>;
export const PLATFORMS: PlatformName[] = ["blocket", "tradera", "vinted", "facebook"];

const yamlPath = (slug: string) => join(itemDir(slug), "item.yaml");

export function loadRecord(slug: string): Record {
  return RecordSchema.parse(parseDocument(readFileSync(yamlPath(slug), "utf8")).toJS());
}

// Edits listings.<p> in place via the yaml Document so comments survive.
export function setListing(slug: string, p: PlatformName, listing: Listing | undefined) {
  const doc = parseDocument(readFileSync(yamlPath(slug), "utf8"));
  if (listing) doc.setIn(["listings", p], listing);
  else doc.deleteIn(["listings", p]);
  writeFileSync(yamlPath(slug), doc.toString());
}

export function adText(rec: Record, p: PlatformName) {
  const lang = rec.platforms[p]?.lang ?? "both"; // all ads bilingual: sv then en
  if (lang === "both")
    return {
      title: rec.ad.sv.title,
      description: `${rec.ad.sv.description.trim()}\n\n${rec.ad.en.description.trim()}`,
    };
  return { title: rec.ad[lang].title, description: rec.ad[lang].description.trim() };
}
