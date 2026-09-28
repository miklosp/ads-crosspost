import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, saveConfig, settings } from "./config.ts";
import { dataDir, ROOT } from "./record.ts";

test("ADS_DATA_DIR overrides the repo root", () => {
  assert.equal(dataDir({}), ROOT);
  assert.equal(dataDir({ ADS_DATA_DIR: "/tmp/ads" }), "/tmp/ads");
});

test("missing or empty config.yaml gives defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "ads-"));
  assert.deepEqual(loadConfig(dir), {});
  writeFileSync(configPath(dir), "");
  assert.deepEqual(loadConfig(dir), {});
  writeFileSync(configPath(dir), 'postcode: "11740"\n');
  assert.deepEqual(loadConfig(dir), { postcode: "11740" });
});

test("saveConfig sets keys and keeps comments and other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ads-"));
  saveConfig({ hide_browsers: false }, dir);
  assert.deepEqual(loadConfig(dir), { hide_browsers: false });
  writeFileSync(configPath(dir), '# mine\npostcode: "11740" # home\nwindow_display: Ads\n');
  assert.deepEqual(settings(loadConfig(dir)), { close_idle_browsers: true, hide_browsers: true, window_display: "Ads" });
  saveConfig({ close_idle_browsers: false, hide_browsers: false }, dir);
  assert.equal(readFileSync(configPath(dir), "utf8"), '# mine\npostcode: "11740" # home\nwindow_display: Ads\nclose_idle_browsers: false\nhide_browsers: false\n');
  saveConfig({ hide_browsers: true }, dir);
  assert.deepEqual(loadConfig(dir), { postcode: "11740", window_display: "Ads", close_idle_browsers: false, hide_browsers: true });
  assert.throws(() => saveConfig({ nope: 1 } as never, dir));
  assert.equal(loadConfig(dir).hide_browsers, true); // rejected write left the file alone
});
