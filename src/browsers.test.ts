import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserContext } from "patchright";
import { browserManager } from "./browsers.ts";
import type { PlatformName } from "./record.ts";

class FakeContext extends EventEmitter {
  closed = false;
  async close() {
    this.closed = true;
    this.emit("close");
  }
}

function fakeLauncher() {
  const launched: { p: PlatformName; ctx: FakeContext }[] = [];
  const launch = async (p: PlatformName) => {
    const ctx = new FakeContext();
    launched.push({ p, ctx });
    return ctx as unknown as BrowserContext;
  };
  return { launch, launched };
}

test("launches lazily, once per platform", async () => {
  const { launch, launched } = fakeLauncher();
  const m = browserManager(launch);
  assert.equal(launched.length, 0);
  const a = await m.get("vinted");
  assert.equal(await m.get("vinted"), a);
  await m.get("blocket");
  assert.deepEqual(launched.map((l) => l.p), ["vinted", "blocket"]);
});

test("concurrent get() shares one launch", async () => {
  const { launch, launched } = fakeLauncher();
  const m = browserManager(launch);
  const [a, b] = await Promise.all([m.get("tradera"), m.get("tradera")]);
  assert.equal(a, b);
  assert.equal(launched.length, 1);
});

test("relaunches after the context closes on its own", async () => {
  const { launch, launched } = fakeLauncher();
  const m = browserManager(launch);
  const a = await m.get("facebook");
  launched[0].ctx.emit("close"); // window closed by hand, or crashed
  const b = await m.get("facebook");
  assert.notEqual(a, b);
  assert.equal(launched.length, 2);
});

test("retries after a failed launch", async () => {
  let n = 0;
  const m = browserManager(async () => {
    if (n++ === 0) throw new Error("boom");
    return new FakeContext() as unknown as BrowserContext;
  });
  await assert.rejects(m.get("vinted"), /boom/);
  await m.get("vinted");
  assert.equal(n, 2);
});

test("close() and closeAll() close contexts and forget them", async () => {
  const { launch, launched } = fakeLauncher();
  const m = browserManager(launch);
  await m.get("vinted");
  await m.get("blocket");
  await m.close("vinted");
  assert.equal(launched[0].ctx.closed, true);
  assert.equal(launched[1].ctx.closed, false);
  await m.closeAll();
  assert.equal(launched[1].ctx.closed, true);
  await m.get("blocket");
  assert.equal(launched.length, 3);
});
