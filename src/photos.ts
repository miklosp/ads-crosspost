import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import decodeHeic from "heic-decode";
import sharp from "sharp";
import { itemDir, type PlatformName, type Record } from "./record.ts";

// Regenerates items/<slug>/out/<p>/NN.jpg: ≤2000px longest edge, q85, EXIF stripped.
export async function preparePhotos(slug: string, rec: Record, p: PlatformName, max: number) {
  const dir = join(itemDir(slug), "out", p);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = rec.photos.slice(0, max);
  if (rec.photos.length > max) console.warn(`${p}: ${rec.photos.length} photos, cap is ${max}; using first ${max}`);
  const out: string[] = [];
  for (const [i, rel] of src.entries()) {
    const dest = join(dir, `${String(i + 1).padStart(2, "0")}.jpg`);
    await sharp(join(itemDir(slug), rel))
      .rotate() // apply EXIF orientation before stripping it
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(dest);
    out.push(dest);
  }
  return out;
}

export const isHeic = (f: string) => /\.hei[cf]$/i.test(f);

// Copies a photo; HEIC/HEIF (undecodable by prebuilt sharp) becomes JPEG. libheif applies irot/imir, and raw pixels carry no metadata.
export async function importPhoto(from: string, dest: string) {
  if (!isHeic(from)) return copyFileSync(from, dest);
  const { width, height, data } = await decodeHeic({ buffer: readFileSync(from) });
  await sharp(data, { raw: { width, height, channels: 4 } }).jpeg({ quality: 92 }).toFile(dest);
}
