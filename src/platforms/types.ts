import type { Page } from "patchright";
import type { Record, PlatformName } from "../record.ts";
import type { config } from "../config.ts";

export type Ctx = {
  record: Record;
  config: typeof config;
  platform: PlatformName;
  photos: string[]; // absolute paths to resized copies, first = cover
  title: string;
  description: string;
  result: { url?: string; id?: string }; // filled by capture_url
};

// Thrown when the site refused the form (validation message, page not left). Nothing was published,
// so flow.ts records "failed" even after submit, and a plain rerun is safe.
export class FormRejected extends Error {}

export type Step = { name: string; run: (page: Page, ctx: Ctx) => Promise<void> };

export type Flow = {
  platform: PlatformName;
  version: number;
  loginUrl: string;
  maxPhotos: number;
  // Validation messages currently shown on the form; checked before submit, dry-run included.
  formErrors?: (page: Page) => Promise<string[]>;
  // Cheap session check: navigates `page` and reports whether the profile is still logged in.
  isLoggedIn?: (page: Page) => Promise<boolean>;
  post: Step[];
  // Ends the live listing at ctx.record.listings[platform] (url/id): marks it sold where the site can, else deletes it.
  // Returns early if the site already ended it (sold through the site's own checkout).
  delist: Step[];
};
