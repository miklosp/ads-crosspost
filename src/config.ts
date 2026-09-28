import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ROOT } from "./record.ts";

// Seller-level settings shared by every item; see config.yaml.
export const config = z.strictObject({ postcode: z.string().regex(/^\d{5}$/), window_display: z.string().optional() }).parse(parse(readFileSync(join(ROOT, "config.yaml"), "utf8")));
