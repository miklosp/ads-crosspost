import type { PlatformName } from "../record.ts";
import { blocket } from "./blocket.ts";
import { facebook } from "./facebook.ts";
import { tradera } from "./tradera.ts";
import type { Flow } from "./types.ts";
import { vinted } from "./vinted.ts";

export const FLOWS: Partial<Record<PlatformName, Flow>> = { blocket, facebook, tradera, vinted };

export function flowFor(name: string): Flow {
  const f = FLOWS[name as PlatformName];
  if (!f) throw new Error(`no flow for "${name}" (have: ${Object.keys(FLOWS).join(", ")})`);
  return f;
}
