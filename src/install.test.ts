import assert from "node:assert/strict";
import { test } from "node:test";
import { installError, parsePercent, unpacked } from "./install.ts";

test("parsePercent reads patchright's non-TTY progress lines", () => {
  assert.equal(parsePercent("|■■■■■■■■                                                                        |  10% of 162.3 MiB"), 10);
  assert.equal(parsePercent("|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 162.3 MiB"), 100);
  assert.equal(parsePercent("Downloading Chromium 140.0 from https://cdn.playwright.dev/x.zip"), undefined);
});

test("unpacked rewrites app.asar to app.asar.unpacked", () => {
  assert.equal(
    unpacked("/Applications/Ads Crosspost.app/Contents/Resources/app.asar/node_modules/patchright/cli.js"),
    "/Applications/Ads Crosspost.app/Contents/Resources/app.asar.unpacked/node_modules/patchright/cli.js",
  );
  assert.equal(unpacked("C:\\x\\resources\\app.asar\\node_modules\\patchright\\cli.js"), "C:\\x\\resources\\app.asar.unpacked\\node_modules\\patchright\\cli.js");
  assert.equal(unpacked("/repo/node_modules/patchright/cli.js"), "/repo/node_modules/patchright/cli.js");
});

test("installError flags offline", () => {
  assert.match(installError("Error: getaddrinfo ENOTFOUND cdn.playwright.dev", 1), /no internet/);
  assert.match(installError("a\nb\nboom\n", 1), /exited with 1: .*boom/);
});
