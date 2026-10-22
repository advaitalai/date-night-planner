import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { pendingJobs, registerJob, runDueJobs, schedule } from "../src/jobs/scheduler";
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
    registerJob("dayof_reminder", async () => void seen.push("dayof"));
    schedule("dayof_reminder", DateTime.now().minus({ hours: 10 }), { reservationId: 1 }, "stale-dayof");
    schedule("dayof_reminder", DateTime.now().minus({ minutes: 5 }), { reservationId: 2 }, "fresh-dayof");
    await runDueJobs();
    expect(seen).toEqual(["dayof"]);
    const row = db().prepare("SELECT status FROM jobs WHERE dedupe_key = 'stale-dayof'").get() as { status: string };
    expect(row.status).toBe("cancelled");
  });
});

describe("no weekly trigger", () => {
  it("schedules nothing by itself: planning starts when someone asks", async () => {
    const { registerReminderJobs } = await import("../src/jobs/reminders");
    registerReminderJobs();
    expect(pendingJobs()).toHaveLength(0);
  });
});
