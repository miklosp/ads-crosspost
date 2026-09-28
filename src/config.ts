import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { DATA } from "./record.ts";

// Seller-level settings shared by every item; see config.example.yaml. Missing file = defaults.
const Config = z.strictObject({ postcode: z.string().regex(/^\d{5}$/).optional(), window_display: z.string().optional() });
export const configPath = (dir = DATA) => join(dir, "config.yaml");
export const loadConfig = (dir = DATA) => Config.parse(existsSync(configPath(dir)) ? parse(readFileSync(configPath(dir), "utf8")) ?? {} : {});
export const config = loadConfig();
