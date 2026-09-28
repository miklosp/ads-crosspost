import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeDir, hostPath, inInbox } from "./photos-paths.ts";

const tmp = mkdtempSync(join(tmpdir(), "ads-paths-"));
const roots = { inbox: join(tmp, "Ads Inbox"), claude: join(tmp, "Claude") };
const put = (rel: string, ageS: number) => {
  const p = join(roots.claude, "local-agent-mode-sessions", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  const t = Date.now() / 1000 - ageS;
  utimesSync(p, t, t);
  return p;
};

test("host paths pass through", () => {
  assert.deepEqual(hostPath("/Users/me/Pictures/a.jpg", roots), { path: "/Users/me/Pictures/a.jpg" });
});

test("attached inbox folder maps to the inbox", () => {
  assert.deepEqual(hostPath("/sessions/brave-owl/mnt/Ads Inbox/sofa/a.jpg", roots), { path: join(roots.inbox, "sofa", "a.jpg") });
  assert.deepEqual(hostPath("/sessions/brave-owl/mnt/Ads Inbox", roots), { path: roots.inbox });
  assert.deepEqual(hostPath("/sessions/x/mnt/Ads Inbox/", roots), { path: roots.inbox });
});

test("uploads resolve to the newest file of that name, noting close duplicates", () => {
  put("acct/org/s1/uploads/other.jpg", 0);
  const old = put("acct/org/s1/uploads/IMG_1.jpg", 3600);
  const mid = put("acct/org/s2/uploads/IMG_1.jpg", 60);
  const newest = put("acct/org/deep/s3/uploads/IMG_1.jpg", 0);
  put("acct/org/s3/outputs/IMG_1.jpg", -60); // not an upload
  const r = hostPath("/sessions/a/mnt/uploads/IMG_1.jpg", roots);
  assert.equal(r.path, newest);
  assert.match(r.note!, /2 uploads/);
  assert.notEqual(r.path, old);
  assert.notEqual(r.path, mid);

  const solo = put("acct/org/s4/uploads/solo.png", 0);
  assert.deepEqual(hostPath("/sessions/a/mnt/uploads/solo.png", roots), { path: solo, note: undefined });
  assert.throws(() => hostPath("/sessions/a/mnt/uploads/missing.jpg", roots), /not found/);
});

test("other VM paths ask for the inbox to be attached", () => {
  for (const p of ["/sessions/a/mnt/Desktop/a.jpg", "/sessions/a/tmp/a.jpg", "/sessions/a/mnt/uploads", "/sessions/a/mnt/outputs/x.jpg"])
    assert.throws(() => hostPath(p, roots), (e: Error) => e.message.includes("attach the inbox folder") && e.message.includes(roots.inbox), p);
});

test("inInbox: inside the inbox but not imported/", () => {
  assert.ok(inInbox(join(roots.inbox, "a.jpg"), roots.inbox));
  assert.ok(inInbox(join(roots.inbox, "sofa", "a.jpg"), roots.inbox));
  assert.ok(!inInbox(join(roots.inbox, "imported", "x", "a.jpg"), roots.inbox));
  assert.ok(!inInbox(roots.inbox, roots.inbox));
  assert.ok(!inInbox(join(tmp, "a.jpg"), roots.inbox));
});

test("claudeDir per platform", () => {
  assert.equal(claudeDir("/Users/u", "darwin"), "/Users/u/Library/Application Support/Claude");
  assert.equal(claudeDir("/h", "win32", { APPDATA: "/h/AppData/Roaming" }), join("/h/AppData/Roaming", "Claude"));
});
