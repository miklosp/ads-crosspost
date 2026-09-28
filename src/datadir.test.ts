import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig } from "./config.ts";
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
