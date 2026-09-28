// Pure logic shared by the main process (notifications, tray) and the window. No Node or Electron imports.
import type { Settings } from "../src/config.ts";
import type { Job } from "../src/jobs.ts";
import type { PlatformName } from "../src/record.ts";

export const PLATFORMS = ["blocket", "tradera", "vinted", "facebook"] as const satisfies readonly PlatformName[];

// What main pushes to the window.
export type AppState = { status: string; error?: string; jobs: Job[]; settings?: Settings };

const ATTENTION: Job["state"][] = ["needs_login", "ready_to_publish"];
export const attentionCount = (jobs: Iterable<Job>) => [...jobs].filter((j) => ATTENTION.includes(j.state)).length;

export const newestFirst = (jobs: Iterable<Job>) => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// Last known login state: the newest login job or needs_login post job for the platform.
export function loginState(jobs: Iterable<Job>, platform: PlatformName): Job["state"] | undefined {
  return newestFirst(jobs).find((j) => j.platform === platform && (j.kind === "login" || j.state === "needs_login"))?.state;
}

// Notification for a job change, or undefined. `seen` holds id:state keys and is updated, so each
// job+state is considered once; nothing is shown while the window has focus (the UI shows it instead).
export function notificationFor(job: Job, seen: Set<string>, windowFocused: boolean): { title: string; body: string } | undefined {
  const key = `${job.id}:${job.state}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (windowFocused) return;
  const p = job.platform;
  if (job.state === "needs_login") return { title: `Log in to ${p}`, body: job.slug ? `${job.slug} is waiting` : "Click to log in" };
  if (job.state === "ready_to_publish") return { title: `${job.slug} ready to review on ${p}`, body: "Check the form, then publish" };
  if (job.state === "failed") return { title: `${p} failed at ${job.step ?? "an unknown step"}`, body: job.error ?? "" };
  if (job.state === "posted" && job.kind === "post") return { title: `Posted to ${p}`, body: job.slug ?? "" };
}
