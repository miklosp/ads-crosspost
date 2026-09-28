---
name: post-ad
description: Create a used-item ad. Interviews the user about the item, writes title + description in Swedish and English, saves a structured record under items/<slug>/. Use when the user wants to sell something, says "new item", "post an ad", or "next object".
---

# post-ad

Goal: one `items/<slug>/item.yaml` per object, with ad text in `sv` and `en`, ready for the uploaders. This skill only gathers info and writes the record — posting is `pnpm post <slug>... --platform <p|all>` (several slugs share one browser per site), run by the user.

## 1. Gather info

Ask only for what's missing. If the user gives photos or a dump of facts, extract what you can first, then ask the rest in **one** batched question. Don't interrogate field by field.

Required:
- what it is (type, brand, model)
- condition: `new_with_tags` | `new` | `like_new` | `good` | `fair` | `poor` — plus any defects, honestly. `new_with_tags` = unused, tags/original packaging still on (Vinted lists it separately); `new` = unused without them
- price (SEK) and whether it's negotiable
- pickup location (city/area)
- shipping: yes/no
- photos: path(s) on disk

Nice to have (ask once, accept "skip"):
- age / bought when, original price
- dimensions / size / weight
- what's included (box, cables, manual)
- reason for selling

## 2. Write the ad

Load `writing-for-humans` before drafting.

Rules:
- Title ≤ 60 chars, leads with the item, includes brand/model. No "!!!", no ALL CAPS.
- Title at most 8 capital letters in total. Vinted refuses titles with "too many capital letters" (12 refused, 8 and 7 accepted, 2026-09-26). Write model names in title case (ALP-X GT → Alp-X), and drop capitalised extras that the description already covers.
- Description: 3–8 short lines. Order: what it is → condition + defects → what's included. No pickup or shipping lines (every platform has its own location and shipping fields; Vinted is shipping-only). Plain, honest, no marketing fluff. Defects are stated, never hidden.
- Write Swedish first (primary market), then English as a natural rewrite, not a literal translation. Same facts in both.
- Don't put the price, location or shipping terms in the description (each platform has its own fields).

Show both versions to the user and iterate until they say it's good.

## 3. Categories and shipping

Pick one category per platform from the site's taxonomy snapshots — never invent a path, the uploader clicks it verbatim:

- Blocket: the keys of `categories` in `src/platforms/blocket.fields.json` — "Main / Sub[ / Produktkategori]". Where a subcategory has third-level children, pick the best one: the first two levels go in `category`, the third in `product_category`. Blank Produktkategori still posts but the ad lands in the wrong filter. If no child clearly fits, show the user the options and ask.
- `src/platforms/tradera.categories.json` — "Top / Sub[ / Sub]", full path to a leaf
- `src/platforms/facebook.categories.json` — flat, one name
- `src/platforms/vinted.categories.json` — "Top / … / Leaf", full path

`rg -i <keyword>` the files rather than reading them whole. Go to the deepest level that fits, and pick the best match yourself. If two leaves fit about equally, or none fits well, show the user the candidates and ask.

Then check what each picked category asks for in `src/platforms/<p>.fields.json` (`categories["<path>"]` → `required` / `optional` field keys; `fields["<key>"]` → label and allowed `options`). Read it with `jq`, never whole:

```sh
jq '.categories["Men / Clothing / Tops & t-shirts / Shirts / Plain shirts"]' src/platforms/vinted.fields.json
jq '.fields["size"].options' src/platforms/vinted.fields.json
```

Values must be copied verbatim from `options`. Which snapshot fields the record can carry today:

- Blocket: `product_category` (the 3rd path level, e.g. "Skjortor"), `colour`, `material`, `fit`, `size`; `item.brand` fills "Varumärke". Blocket's `condition` only appears once a `product_category` is picked in clothing/shoes.
- Vinted: `size` (required where the category has a size grid), `colours`.
- Facebook: `tags` only.
- Tradera: none beyond category/condition. If a Tradera category has required attributes other than `condition` (clothing: `clothes_size`, `color`), tell the user the Tradera flow can't fill them yet and leave Tradera out.

Vinted also needs 1–2 `colours` from: Black, Grey, White, Cream, Beige, Apricot, Orange, Coral, Red, Burgundy, Pink, Rose, Purple, Lilac, Light blue, Blue, Navy, Turquoise, Mint, Green, Dark green, Khaki, Brown, Mustard, Yellow, Silver, Gold, Multi, Clear. Show the three picks to the user with the ad text; they confirm or override.

If `shipping: true`, also ask for parcel size and weight (one question): Blocket `package` small ≤5 kg 35×25×12 / medium ≤10 kg 55×40×40 / large ≤15 kg / xl ≤20 kg; Tradera `package` small 34×24×7 / medium 60×40×20 / large 40×40×120 and Vinted `package` small (envelope) / medium (shoebox) / large (moving box); plus `weight` as Tradera's label ("50 g", "100 g", "250 g", "max 500 g", "1 kg", "2 kg", "3 kg", "5 kg", "7 kg", "9 kg", "10 kg", "12 kg", "15 kg", "20 kg").

## 4. Save

Slug: lowercase kebab of brand+item, e.g. `ikea-poang-armchair`. If it exists, append `-2`.

Copy photos into `items/<slug>/photos/` (keep originals untouched). Write `items/<slug>/item.yaml`:

```yaml
slug: ikea-poang-armchair
created: 2026-09-11
status: draft            # draft | ready | posted | sold | delisted
item:
  type: armchair
  brand: IKEA
  model: Poäng
  condition: good        # new_with_tags | new | like_new | good | fair | poor
  defects: "Small scratch on left armrest"
  included: "Cushion"
  age: "Bought 2021"
  dimensions: "68×82×100 cm"
price:
  sek: 400
  negotiable: true
location: "Stockholm, Södermalm"   # free text for the ad; postcode lives in config.yaml
shipping: false
photos:
  - photos/01.jpg
  - photos/02.jpg
ad:
  sv:
    title: ""
    description: |
      ...
  en:
    title: ""
    description: |
      ...
platforms:               # a key present = post there
  blocket:
    category: "Möbler och inredning / Fåtöljer och stolar"
    package: medium      # only when shipping: true — small | medium | large | xl
    # clothing/shoes only, from blocket.fields.json: product_category, colour, material, fit, size
  tradera:
    category: "Möbler & Inredning / Stolar & Fåtöljer"
    mode: fixed
    weight: "5 kg"       # only when shipping: true
    package: large       # only when shipping: true — small | medium | large
  facebook:
    category: "Furniture"
    tags: ["fåtölj", "armchair"]   # optional, max 20
  vinted:                # shipping-only site; omit the key when shipping: false
    category: "Home / Furniture / Chairs & seating / Armchairs"
    package: large
    colours: [Beige, Brown]
    # size: "L"          # when the category's required fields include size
listings: {}             # written only by the uploaders
```

Omit optional keys the user skipped rather than writing empty strings.

## 5. Finish

Print the path and ask: "Next object?"
