import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { DATA } from "./record.ts";

// Seller-level settings shared by every item; see config.example.yaml. Missing file = defaults.
const Config = z.strictObject({
  postcode: z.string().regex(/^\d{5}$/).optional(),
  window_display: z.string().optional(),
  close_idle_browsers: z.boolean().optional(),
  hide_browsers: z.boolean().optional(),
});
type Config = z.infer<typeof Config>;
export const configPath = (dir = DATA) => join(dir, "config.yaml");
export const loadConfig = (dir = DATA) => Config.parse(existsSync(configPath(dir)) ? parse(readFileSync(configPath(dir), "utf8")) ?? {} : {});
export const config = loadConfig();

// The app's Settings checkboxes, with defaults filled in.
export type Settings = { close_idle_browsers: boolean; hide_browsers: boolean; window_display?: string };
export const settings = (c: Config): Settings => ({
  close_idle_browsers: c.close_idle_browsers ?? true,
  hide_browsers: c.hide_browsers ?? !!c.window_display,
  window_display: c.window_display,
});

// Sets keys in config.yaml, keeping comments and the other keys.
export function saveConfig(patch: Partial<Config>, dir = DATA) {
  const doc = parseDocument(existsSync(configPath(dir)) ? readFileSync(configPath(dir), "utf8") : "");
  for (const [k, v] of Object.entries(patch)) doc.set(k, v);
  Config.parse(doc.toJS() ?? {});
  writeFileSync(configPath(dir), String(doc));
}
