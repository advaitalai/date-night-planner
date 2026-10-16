import type { DateTime } from "luxon";
import { db } from "../db";

/**
 * Durable job queue in SQLite: jobs survive restarts and deploys. A job with a
 * dedupe key is only ever scheduled once per key.
 */

type Handler = (payload: any) => Promise<void>;

const handlers = new Map<string, Handler>();
let timer: NodeJS.Timeout | undefined;
let running = false;

export function registerJob(type: string, handler: Handler): void {
  handlers.set(type, handler);
}

export function schedule(type: string, runAt: DateTime, payload: object = {}, dedupeKey?: string): void {
  db()
    .prepare("INSERT OR IGNORE INTO jobs (run_at, type, payload, dedupe_key) VALUES (?, ?, ?, ?)")
    .run(runAt.toUTC().toISO(), type, JSON.stringify(payload), dedupeKey ?? null);
}

/** Cancel pending jobs whose dedupe key starts with a prefix, e.g. "res:12:". */
export function cancelJobs(dedupePrefix: string): number {
  return db()
    .prepare("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND dedupe_key LIKE ?")
    .run(`${dedupePrefix}%`).changes;
}

export function pendingJobs(): { id: number; run_at: string; type: string; dedupe_key: string | null }[] {
  return db().prepare("SELECT id, run_at, type, dedupe_key FROM jobs WHERE status = 'pending' ORDER BY run_at").all() as {
    id: number;
    run_at: string;
    type: string;
    dedupe_key: string | null;
  }[];
}

const MAX_ATTEMPTS = 3;

/**
 * Jobs that post a message or place a call are not retried: if WhatsApp times
 * out after delivering, a retry sends it twice (the day-of reminder did), and a
 * call must never repeat without a yes.
 */
const NO_RETRY = new Set(["dayof_reminder", "cancel_guard", "nudge", "decide", "kickoff", "phone_call"]);

/**
 * Reminders that are pointless once they're this late (e.g. the app was off
 * when they were due). They're dropped instead of all firing at startup.
 */
const STALE_AFTER_MS: Record<string, number> = {
  nudge: 2 * 3600_000,
  dayof_reminder: 6 * 3600_000,
};

export async function runDueJobs(nowIso = new Date().toISOString()): Promise<number> {
  if (running) return 0;
  running = true;
  let ran = 0;
  try {
    const due = db()
      .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20")
      .all(nowIso) as { id: number; type: string; payload: string; attempts: number; run_at: string }[];
    for (const job of due) {
      const staleAfter = STALE_AFTER_MS[job.type];
      if (staleAfter && Date.parse(nowIso) - Date.parse(job.run_at) > staleAfter) {
        db().prepare("UPDATE jobs SET status = 'cancelled', last_error = 'stale: missed while the app was off' WHERE id = ?").run(job.id);
        console.log(`[jobs] skipped stale ${job.type}#${job.id} (due ${job.run_at})`);
        continue;
      }
      const handler = handlers.get(job.type);
      if (!handler) {
        db().prepare("UPDATE jobs SET status = 'failed', last_error = 'no handler' WHERE id = ?").run(job.id);
        continue;
      }
      try {
        await handler(JSON.parse(job.payload));
        db().prepare("UPDATE jobs SET status = 'done', attempts = attempts + 1 WHERE id = ?").run(job.id);
      } catch (err) {
        const attempts = job.attempts + 1;
        const retryAt = new Date(Date.now() + 5 * 60_000 * attempts).toISOString();
        db()
          .prepare("UPDATE jobs SET attempts = ?, last_error = ?, status = ?, run_at = ? WHERE id = ?")
          .run(attempts, String((err as Error).stack ?? err), attempts >= MAX_ATTEMPTS || NO_RETRY.has(job.type) ? "failed" : "pending", retryAt, job.id);
        console.error(`job ${job.type}#${job.id} failed (attempt ${attempts}):`, err);
      }
      ran++;
    }
  } finally {
    running = false;
  }
  return ran;
}

export function startScheduler(intervalMs = 30_000): void {
  timer = setInterval(() => void runDueJobs(), intervalMs);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
}
