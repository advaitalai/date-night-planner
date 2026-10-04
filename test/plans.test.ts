import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { createPlan } from "../src/db/repo";
import { pendingJobs, registerJob, runDueJobs, schedule } from "../src/jobs/scheduler";
import { ensureWeeklyJobs } from "../src/jobs/weekly";
import { consensus, rankByVotes } from "../src/plans/decide";
import { ZONE } from "../src/util/time";
import { freshDb } from "./helpers";

beforeEach(freshDb);

function plan(votes: Record<string, number[]>) {
  const p = createPlan({
    date: "2026-10-07",
    time: "18:30",
    party_size: 2,
    status: "proposed",
    request: null,
    options: ["A", "B", "C"].map((name, i) => ({ placeId: i + 1, name, availability: "available" as const, pitch: "", score: 3 - i })),
  });
  return { ...p, votes };
}

describe("votes", () => {
  it("books when both pick the same option", () => {
    expect(consensus(plan({ Advait: [1], Emily: [1] }))).toBe(1);
    expect(consensus(plan({ Advait: [1], Emily: [2] }))).toBeNull();
    expect(consensus(plan({ Advait: [1] }))).toBeNull();
  });

  it("ranks by votes, ties go to the higher-ranked option", () => {
    expect(rankByVotes(plan({ Advait: [2], Emily: [1] }))).toEqual([1, 2, 0]);
    expect(rankByVotes(plan({ Advait: [2], Emily: [2] }))).toEqual([2, 0, 1]);
  });
});

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
});

describe("weekly rhythm", () => {
  it("schedules Saturday kickoff, Sunday nudge and decide for the coming Wednesday", () => {
    const thursday = DateTime.fromISO("2026-10-01T12:00", { zone: ZONE });
    ensureWeeklyJobs(thursday);
    ensureWeeklyJobs(thursday); // idempotent
    const jobs = pendingJobs().map((j) => [j.type, DateTime.fromISO(j.run_at).setZone(ZONE).toFormat("ccc yyyy-MM-dd HH:mm")]);
    expect(jobs).toEqual([
      ["kickoff", "Sat 2026-10-03 10:00"],
      ["nudge", "Sun 2026-10-04 10:00"],
      ["decide", "Sun 2026-10-04 20:00"],
    ]);
    expect(pendingJobs()[0].dedupe_key).toContain("2026-10-07");
  });
});
