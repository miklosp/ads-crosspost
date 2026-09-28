// App window: status, platform logins, jobs, and review of ready_to_publish jobs. Talks to main via window.api.
import type { Job } from "../src/jobs.ts";
import { loginState, newestFirst, PLATFORMS, type AppState } from "./attention.ts";
import type { Api } from "./preload.ts";

const api = (window as unknown as { api: Api }).api;
const $ = (id: string) => document.getElementById(id)!;

let state: AppState = { status: "", jobs: [] };
let focused: string | undefined;
const confirming = new Set<string>();
const shots = new Map<string, string>(); // job id → data URL ("" if unavailable)
const loading = new Set<string>();

function h(tag: string, props: Record<string, string | ((e: Event) => void)> = {}, ...kids: (Node | string | undefined)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) typeof v === "function" ? el.addEventListener(k, v) : el.setAttribute(k, v);
  el.append(...kids.filter((k) => k !== undefined));
  return el;
}

const LOGIN_LABEL: Partial<Record<Job["state"], string>> = {
  logged_in: "Logged in", needs_login: "Needs login", queued: "Logging in…", running: "Logging in…",
  cancelled: "Not logged in", failed: "Login failed", expired: "Unknown",
};

function render() {
  $("status").textContent = state.status;
  $("error").textContent = state.error ?? "";

  $("platforms").replaceChildren(...PLATFORMS.map((p) => {
    const s = loginState(state.jobs, p);
    return h("li", {}, h("span", { class: "name" }, p), h("span", { class: `muted ${s ?? ""}` }, s ? LOGIN_LABEL[s] ?? s : "Unknown"),
      h("button", { click: () => api.login(p) }, "Log in"));
  }));

  const review = newestFirst(state.jobs.filter((j) => j.state === "ready_to_publish"));
  $("review-section").hidden = review.length === 0;
  $("review").replaceChildren(...review.map(reviewCard));

  const jobs = newestFirst(state.jobs);
  $("jobs").replaceChildren(...(jobs.length ? jobs.map(jobRow) : [h("li", { class: "muted" }, "No jobs yet")]));
}

function reviewCard(j: Job) {
  const shot = shots.get(j.id);
  if (shot === undefined && !loading.has(j.id)) {
    loading.add(j.id);
    void api.screenshot(j.id).then((url) => (loading.delete(j.id), shots.set(j.id, url ?? ""), render()));
  }
  const actions = confirming.has(j.id)
    ? [h("strong", {}, `Publish to ${j.platform}?`),
       h("button", { class: "primary", click: () => (confirming.delete(j.id), api.publish(j.id)) }, "Publish"),
       h("button", { click: () => (confirming.delete(j.id), render()) }, "Back")]
    : [h("button", { class: "primary", click: () => (confirming.add(j.id), render()) }, "Publish…"),
       h("button", { click: () => api.cancel(j.id) }, "Cancel")];
  return h("div", { class: `card${focused === j.id ? " focused" : ""}`, "data-job": j.id },
    h("div", {}, h("strong", {}, j.slug ?? j.id), ` on ${j.platform}`),
    shot ? h("img", { src: shot, alt: `Filled form for ${j.slug} on ${j.platform}` })
      : h("p", { class: "muted" }, shot === "" ? "Screenshot unavailable" : "Loading screenshot…"),
    h("div", { class: "actions" }, ...actions));
}

function jobRow(j: Job) {
  const detail = j.state === "failed" ? `${j.step ? `at ${j.step}: ` : ""}${j.error ?? ""}` : j.step;
  return h("li", { class: focused === j.id ? "focused" : "", "data-job": j.id },
    h("span", { class: "name" }, j.kind === "login" ? "login" : j.slug ?? j.id),
    h("span", {}, j.platform),
    h("span", { class: `state ${j.state}` }, j.state.replaceAll("_", " ")),
    detail ? h("span", { class: "muted detail" }, detail) : undefined,
    j.url ? h("a", { href: "#", click: (e) => (e.preventDefault(), api.openUrl(j.url!)) }, "View") : undefined);
}

api.onState((s) => {
  state = s;
  for (const id of shots.keys()) if (!s.jobs.some((j) => j.id === id && j.state === "ready_to_publish")) shots.delete(id);
  render();
});
const scrollToFocused = () => focused && document.querySelector(`[data-job="${CSS.escape(focused)}"]`)?.scrollIntoView({ block: "center" });
api.onFocusJob((id) => ((focused = id), render(), scrollToFocused()));
void api.state().then((s) => ((state = s), render(), scrollToFocused()));
