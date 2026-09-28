import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { importData } from "./import.ts";

const put = (file: string, body = "x") => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, body));
const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "ads-import-"));
  return { from: join(root, "checkout"), to: join(root, "app") };
};
const profile = (dir: string, p: string, marker = "old") => {
  const s = join(dir, "sessions", p);
  put(join(s, "Local State"), marker);
  put(join(s, "Default", "Cookies"), marker);
  put(join(s, "Default", "Local Storage", "leveldb", "000003.log"));
  put(join(s, "Default", "IndexedDB", "https_example.se_0.indexeddb.leveldb", "CURRENT"));
  put(join(s, "Default", "Cache", "Cache_Data", "data_0"));
  put(join(s, "Default", "Code Cache", "js", "index"));
  put(join(s, "Default", "GPUCache", "data_0"));
  put(join(s, "Default", "Service Worker", "CacheStorage", "abc", "index"));
  put(join(s, "Default", "Service Worker", "Database", "CURRENT"));
  put(join(s, "GraphiteDawnCache", "data_0"));
  put(join(s, "component_crx_cache", "x.crx"));
  return s;
};

test("copies items, skipping slugs already in the app", async () => {
  const { from, to } = dirs();
  put(join(from, "items", "chair", "record.yaml"), "from");
  put(join(from, "items", "chair", "photos", "1.jpg"));
  put(join(from, "items", "lamp", "record.yaml"), "from");
  put(join(to, "items", "lamp", "record.yaml"), "app");
  const s = await importData(from, to);
  assert.deepEqual(s.items, { copied: ["chair"], skipped: ["lamp"] });
  assert.ok(existsSync(join(to, "items", "chair", "photos", "1.jpg")));
  assert.equal(readFileSync(join(to, "items", "lamp", "record.yaml"), "utf8"), "app");
});

test("copies session profiles without Chromium caches", async () => {
  const { from, to } = dirs();
  profile(from, "blocket");
  const s = await importData(from, to);
  assert.deepEqual(s.sessions, { copied: ["blocket"], skipped: [], refused: [] });
  const d = join(to, "sessions", "blocket");
  for (const kept of ["Local State", "Default/Cookies", "Default/Local Storage/leveldb/000003.log",
    "Default/IndexedDB/https_example.se_0.indexeddb.leveldb/CURRENT", "Default/Service Worker/Database/CURRENT"])
    assert.ok(existsSync(join(d, kept)), kept);
  for (const gone of ["Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/Service Worker/CacheStorage",
    "GraphiteDawnCache", "component_crx_cache"])
    assert.ok(!existsSync(join(d, gone)), gone);
});

test("refuses a profile whose Chromium is running", async () => {
  const { from, to } = dirs();
  symlinkSync("myhost-12345", join(profile(from, "tradera"), "SingletonLock")); // dangling, as Chromium makes it
  profile(from, "vinted");
  const s = await importData(from, to);
  assert.deepEqual(s.sessions.copied, ["vinted"]);
  assert.equal(s.sessions.refused.length, 1);
  assert.equal(s.sessions.refused[0].platform, "tradera");
  assert.match(s.sessions.refused[0].reason, /in use/);
  assert.ok(!existsSync(join(to, "sessions", "tradera")));
});

test("keeps an existing app profile unless overwrite, and never replaces an open one", async () => {
  const { from, to } = dirs();
  profile(from, "blocket", "old");
  profile(to, "blocket", "app");
  let s = await importData(from, to);
  assert.deepEqual(s.sessions, { copied: [], skipped: ["blocket"], refused: [] });
  assert.equal(readFileSync(join(to, "sessions", "blocket", "Default", "Cookies"), "utf8"), "app");

  s = await importData(from, to, { overwrite: true });
  assert.deepEqual(s.sessions.copied, ["blocket"]);
  assert.equal(readFileSync(join(to, "sessions", "blocket", "Default", "Cookies"), "utf8"), "old");
  assert.ok(!existsSync(join(to, "sessions", "blocket", "Default", "Cache")));

  symlinkSync("myhost-1", join(to, "sessions", "blocket", "SingletonLock"));
  s = await importData(from, to, { overwrite: true });
  assert.deepEqual(s.sessions.copied, []);
  assert.match(s.sessions.refused[0].reason, /app's blocket browser is open/);
});

test("copies config.yaml only when the app has none", async () => {
  const { from, to } = dirs();
  put(join(from, "items", "a", "record.yaml"));
  assert.equal((await importData(from, to)).config, "absent");
  put(join(from, "config.yaml"), 'postcode: "11740"\n');
  assert.equal((await importData(from, to)).config, "copied");
  assert.equal(readFileSync(join(to, "config.yaml"), "utf8"), 'postcode: "11740"\n');
  put(join(from, "config.yaml"), 'postcode: "22222"\n');
  assert.equal((await importData(from, to)).config, "kept");
  assert.equal(readFileSync(join(to, "config.yaml"), "utf8"), 'postcode: "11740"\n');
});

test("rejects a folder that isn't a checkout", async () => {
  const { from, to } = dirs();
  mkdirSync(from, { recursive: true });
  await assert.rejects(importData(from, to), /no items\/ or sessions\//);
  await assert.rejects(importData(to, to), /already the data folder/);
});
