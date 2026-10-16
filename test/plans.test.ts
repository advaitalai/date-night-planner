import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { pendingJobs, registerJob, runDueJobs, schedule } from "../src/jobs/scheduler";
import { ensureWeeklyJobs } from "../src/jobs/weekly";
import { ZONE } from "../src/util/time";
import { freshDb } from "./helpers";

beforeEach(freshDb);

describe("scheduler", () => {
  it("runs due jobs once and dedupes by key", async () => {
    const seen: number[] = [];
    registerJob("test", async ({ n }) => void seen.push(n));
    const past = DateTime.now().minus({ minutes: 1 });
    schedule("test", past, { n: 1 }, "k1");
    schedule("test", past, { n: 2 }, "k1");
    schedule("test", DateTime.now().plus({ hours: 1 }), { n: 3 });
    await runDueJobs();
    expect(seen).toEqual([1]);
    expect(pendingJobs()).toHaveLength(1);
  });

  it("retries failed jobs later", async () => {
    registerJob("flaky", async () => {
      throw new Error("boom");
    });
    schedule("flaky", DateTime.now().minus({ minutes: 1 }));
    await runDueJobs();
    const row = db().prepare("SELECT status, attempts FROM jobs WHERE type = 'flaky'").get() as { status: string; attempts: number };
    expect(row).toEqual({ status: "pending", attempts: 1 });
  });

  it("drops reminders that were missed while the app was off", async () => {
    const seen: string[] = [];
    registerJob("nudge", async () => void seen.push("nudge"));
    schedule("nudge", DateTime.now().minus({ hours: 10 }), { date: "2026-10-14" }, "stale-nudge");
    schedule("nudge", DateTime.now().minus({ minutes: 5 }), { date: "2026-10-21" }, "fresh-nudge");
    await runDueJobs();
    expect(seen).toEqual(["nudge"]);
    const row = db().prepare("SELECT status FROM jobs WHERE dedupe_key = 'stale-nudge'").get() as { status: string };
    expect(row.status).toBe("cancelled");
  });
});

describe("weekly rhythm", () => {
  it("schedules Saturday kickoff and a Sunday nudge for the coming Wednesday, and never books by itself", () => {
    const thursday = DateTime.fromISO("2026-10-01T12:00", { zone: ZONE });
    ensureWeeklyJobs(thursday);
    ensureWeeklyJobs(thursday); // idempotent
    const jobs = pendingJobs().map((j) => [j.type, DateTime.fromISO(j.run_at).setZone(ZONE).toFormat("ccc yyyy-MM-dd HH:mm")]);
    expect(jobs).toEqual([
      ["kickoff", "Sat 2026-10-03 10:00"],
      ["nudge", "Sun 2026-10-04 10:00"],
    ]);
    expect(pendingJobs()[0].dedupe_key).toContain("2026-10-07");
  });
});
