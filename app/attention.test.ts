import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "../src/jobs.ts";
import { attentionCount, loginState, notificationFor } from "./attention.ts";

const job = (p: Partial<Job>): Job => ({
  id: "a", kind: "post", slug: "chair", platform: "blocket", state: "queued",
  createdAt: "2026-09-28T10:00:00Z", updatedAt: "2026-09-28T10:00:00Z", ...p,
});

test("notifies once per job+state, with the expected titles", () => {
  const seen = new Set<string>();
  assert.equal(notificationFor(job({ state: "running" }), seen, false), undefined);
  assert.equal(notificationFor(job({ state: "needs_login" }), seen, false)?.title, "Log in to blocket");
  assert.equal(notificationFor(job({ state: "needs_login" }), seen, false), undefined);
  assert.equal(notificationFor(job({ id: "b", state: "ready_to_publish" }), seen, false)?.title, "chair ready to review on blocket");
  assert.equal(notificationFor(job({ id: "c", state: "failed", step: "photos" }), seen, false)?.title, "blocket failed at photos");
  assert.equal(notificationFor(job({ id: "d", state: "posted", platform: "vinted" }), seen, false)?.title, "Posted to vinted");
});

test("stays silent while the window has focus, and doesn't notify later for that state", () => {
  const seen = new Set<string>();
  assert.equal(notificationFor(job({ state: "ready_to_publish" }), seen, true), undefined);
  assert.equal(notificationFor(job({ state: "ready_to_publish" }), seen, false), undefined);
});

test("no notification for a successful login", () => {
  assert.equal(notificationFor(job({ kind: "login", state: "logged_in" }), new Set(), false), undefined);
});

test("attention counts needs_login and ready_to_publish", () => {
  const jobs = [job({ state: "needs_login" }), job({ state: "ready_to_publish" }), job({ state: "posted" }), job({ state: "failed" })];
  assert.equal(attentionCount(jobs), 2);
  assert.equal(attentionCount([]), 0);
});

test("login state comes from the newest login or needs_login job", () => {
  const jobs = [
    job({ id: "1", kind: "login", state: "logged_in", updatedAt: "2026-09-28T10:00:00Z" }),
    job({ id: "2", state: "needs_login", updatedAt: "2026-09-28T11:00:00Z" }),
    job({ id: "3", state: "posted", updatedAt: "2026-09-28T12:00:00Z" }),
    job({ id: "4", kind: "login", platform: "vinted", state: "logged_in" }),
  ];
  assert.equal(loginState(jobs, "blocket"), "needs_login");
  assert.equal(loginState(jobs, "vinted"), "logged_in");
  assert.equal(loginState(jobs, "tradera"), undefined);
});
