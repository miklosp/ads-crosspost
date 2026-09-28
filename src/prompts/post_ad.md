# post-ad

Goal: one item record per object, with ad text in `sv` and `en`, created with `create_item`, then posted to each platform with `prepare_post` → user approval → `publish`.

## 1. Photos and info

Pick the slug first: lowercase kebab of brand+item, e.g. `ikea-poang-armchair`. If `list_items` already has it, append `-2`.

Call `add_photos(slug)` and look at the thumbnails it returns. Extract what you can from them. With no `folder`/`paths` it imports the user's photo inbox folder; pass `folder` or `paths` for photos elsewhere. In Cowork, pass the `/sessions/...` paths you see (attached inbox folder, files dropped in the chat) as-is.

Ask only for what's missing. If the user gives photos or a dump of facts, extract what you can first, then ask the rest in **one** batched question. Don't interrogate field by field.

Required:
- what it is (type, brand, model)
- condition: `new_with_tags` | `new` | `like_new` | `good` | `fair` | `poor` — plus any defects, honestly. `new_with_tags` = unused, tags/original packaging still on (Vinted lists it separately); `new` = unused without them
- price (SEK) and whether it's negotiable
- pickup location (city/area)
- shipping: yes/no
- photos: in the inbox folder, or a folder or file paths on the user's computer

Nice to have (ask once, accept "skip"):
- age / bought when, original price
- dimensions / size / weight
- what's included (box, cables, manual)
- reason for selling

## 2. Write the ad

Write like a person selling their own thing: short plain sentences, no filler, no hype words.

Rules:
- Title ≤ 60 chars, leads with the item, includes brand/model. No "!!!", no ALL CAPS.
- Title at most 8 capital letters in total. Vinted refuses titles with "too many capital letters" (12 refused, 8 and 7 accepted, 2026-09-26). Write model names in title case (ALP-X GT → Alp-X), and drop capitalised extras that the description already covers.
- Description: 3–8 short lines. Order: what it is → condition + defects → what's included. No pickup or shipping lines (every platform has its own location and shipping fields; Vinted is shipping-only). Plain, honest, no marketing fluff. Defects are stated, never hidden.
- Write Swedish first (primary market), then English as a natural rewrite, not a literal translation. Same facts in both.
- Don't put the price, location or shipping terms in the description (each platform has its own fields).

Show both versions to the user and iterate until they say it's good.

## 3. Categories and shipping

Pick one category per platform with `search_categories(platform, query)` — never invent a path, the uploader clicks it verbatim. Use short keyword queries (Swedish for Blocket and Tradera, English for Facebook and Vinted) and refine until the hit list is small.

- Blocket: paths are "Main / Sub[ / Produktkategori]". Where a subcategory has third-level children, pick the best one: the first two levels go in `category`, the third in `product_category`. Blank Produktkategori still posts but the ad lands in the wrong filter. If no child clearly fits, show the user the options and ask.
- Tradera: "Top / Sub[ / Sub]", full path to a leaf
- Facebook: flat, one name
- Vinted: "Top / … / Leaf", full path

Go to the deepest level that fits, and pick the best match yourself. If two leaves fit about equally, or none fits well, show the user the candidates and ask.

Then call `get_category_fields(platform, category)` for each pick: `required` / `optional` field keys, with labels and allowed `options`. For long option lists use `search_options(platform, field, query)`. Values must be copied verbatim from `options`. Which fields the record can carry today:

- Blocket: `product_category` (the 3rd path level, e.g. "Skjortor"), `colour`, `material`, `fit`, `size`; `item.brand` fills "Varumärke". Blocket's `condition` only appears once a `product_category` is picked in clothing/shoes.
- Vinted: `size` (required where the category has a size grid), `colours`.
- Facebook: `tags` only.
- Tradera: none beyond category/condition. If a Tradera category has required attributes other than `condition` (clothing: `clothes_size`, `color`), tell the user the Tradera flow can't fill them yet and leave Tradera out.

Vinted also needs 1–2 `colours` from: Black, Grey, White, Cream, Beige, Apricot, Orange, Coral, Red, Burgundy, Pink, Rose, Purple, Lilac, Light blue, Blue, Navy, Turquoise, Mint, Green, Dark green, Khaki, Brown, Mustard, Yellow, Silver, Gold, Multi, Clear. Show the three picks to the user with the ad text; they confirm or override.

If `shipping: true`, also ask for parcel size and weight (one question): Blocket `package` small ≤5 kg 35×25×12 / medium ≤10 kg 55×40×40 / large ≤15 kg / xl ≤20 kg; Tradera `package` small 34×24×7 / medium 60×40×20 / large 40×40×120 and Vinted `package` small (envelope) / medium (shoebox) / large (moving box); plus `weight` as Tradera's label ("50 g", "100 g", "250 g", "max 500 g", "1 kg", "2 kg", "3 kg", "5 kg", "7 kg", "9 kg", "10 kg", "12 kg", "15 kg", "20 kg").

## 4. Save

Call `create_item` with `fields` shaped like this (shown as YAML; `photos` are the paths `add_photos` returned):

```yaml
slug: ikea-poang-armchair
status: ready            # draft | ready | posted | sold | delisted
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
    # clothing/shoes only, from get_category_fields: product_category, colour, material, fit, size
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
```

Omit optional keys the user skipped rather than writing empty strings. To change a saved item, use `update_item` with a merge patch.

## 5. Post

Ask the user which platforms to post to now. Then, one platform at a time:

1. `prepare_post(slug, platform)`, then `wait_for_status(job_id)` until the state settles.
2. `ready_to_publish`: show the screenshot, point out anything that looks wrong, and ask "Publish on <platform>?". Call `publish(job_id)` only on an explicit yes, then `wait_for_status` until `posted` and give the user the URL. On no, `cancel(job_id)`, fix the record with `update_item`, and prepare again.
3. `needs_login`: ask the user to log in (call `login(platform)`, they log in in the browser window that opens), wait for `logged_in`, then prepare again.
4. `failed`: report the step and error. Don't retry blindly; retry only if the error looks transient or the user asks.

## 6. Finish

Summarise what got posted where, and ask: "Next object?"
