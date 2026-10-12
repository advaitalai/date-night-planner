import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { db } from "./db";

/**
 * The debugging record: every phone call and every booking attempt goes into
 * the database (so it survives restarts and can be listed with `npm run logs`),
 * and the terminal log is also written to data/logs/YYYY-MM-DD.log.
 */

export interface CallLog {
  placeId: number | null;
  placeName: string;
  kind: string;
  toNumber: string | null;
  vapiId?: string | null;
  endedReason?: string | null;
  durationSec?: number | null;
  costUsd?: number | null;
  outcome: string;
  summary: string;
  transcript?: string | null;
  recordingUrl?: string | null;
  dryRun: boolean;
}

export function logCall(c: CallLog): void {
  try {
    db()
      .prepare(
        `INSERT INTO call_log (place_id, place_name, kind, to_number, vapi_id, ended_reason, duration_sec, cost_usd, outcome, summary, transcript, recording_url, dry_run)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.placeId, c.placeName, c.kind, c.toNumber, c.vapiId ?? null, c.endedReason ?? null, c.durationSec ?? null, c.costUsd ?? null, c.outcome, c.summary, c.transcript ?? null, c.recordingUrl ?? null, c.dryRun ? 1 : 0);
  } catch (err) {
    console.warn("call log failed:", (err as Error).message);
  }
}

export interface AttemptLog {
  placeId: number;
  placeName: string;
  date: string;
  time: string;
  channel: string;
  result: string;
  detail?: string | null;
}

export function logAttempt(a: AttemptLog): void {
  try {
    db()
      .prepare("INSERT INTO booking_log (place_id, place_name, date, time, channel, result, detail, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.placeId, a.placeName, a.date, a.time, a.channel, a.result, a.detail?.slice(0, 4000) ?? null, config.dryRun ? 1 : 0);
  } catch (err) {
    console.warn("booking log failed:", (err as Error).message);
  }
}

/** Also write everything the app prints to data/logs/<day>.log (kept across restarts). */
export function logToFile(): void {
  const dir = path.join(config.dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const now = new Date();
        const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(" ");
        fs.appendFileSync(path.join(dir, `${now.toISOString().slice(0, 10)}.log`), `${now.toISOString()} ${level.toUpperCase()} ${line}\n`);
      } catch {
        // logging must never break the app
      }
    };
  }
}
