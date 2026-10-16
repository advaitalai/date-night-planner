import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { OpeningPeriod } from "../src/types";
import { freeCancelDeadline, isOpenFor, jst, nextWeekday, nextWeeklyMoment, ZONE } from "../src/util/time";

const sat = DateTime.fromISO("2026-10-03T10:00", { zone: ZONE }); // a Saturday

describe("dates", () => {
  it("targets the coming Wednesday from a Saturday kickoff", () => {
    expect(nextWeekday(sat, 3)).toBe("2026-10-07");
  });

  it("never returns the same day", () => {
    const wed = DateTime.fromISO("2026-10-07T09:00", { zone: ZONE });
    expect(nextWeekday(wed, 3)).toBe("2026-10-14");
  });

  it("finds the next weekly moment strictly after now", () => {
    expect(nextWeeklyMoment(sat, 6, "10:00").toISO()).toContain("2026-10-10T10:00");
    expect(nextWeeklyMoment(sat.minus({ minutes: 1 }), 6, "10:00").toISO()).toContain("2026-10-03T10:00");
    expect(nextWeeklyMoment(sat, 7, "20:00").toISO()).toContain("2026-10-04T20:00");
  });
});

describe("opening hours", () => {
  // Wed 17:00–23:00, Fri 18:00–02:00 (crosses midnight), Sat 23:00–Sun 03:00
  const periods: OpeningPeriod[] = [
    { open: { day: 3, hour: 17, minute: 0 }, close: { day: 3, hour: 23, minute: 0 } },
    { open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
    { open: { day: 6, hour: 23, minute: 0 }, close: { day: 0, hour: 3, minute: 0 } },
  ];

  it("is open for a dinner on Wednesday", () => {
    expect(isOpenFor(periods, jst("2026-10-07", "18:30"))).toBe(true);
  });
  it("is closed on Tuesday", () => {
    expect(isOpenFor(periods, jst("2026-10-06", "18:30"))).toBe(false);
  });
  it("rejects a booking that runs past closing", () => {
    expect(isOpenFor(periods, jst("2026-10-07", "22:00"))).toBe(false);
  });
  it("handles periods that cross midnight and the week wrap", () => {
    expect(isOpenFor(periods, jst("2026-10-09", "23:30"))).toBe(true);
    expect(isOpenFor(periods, jst("2026-10-10", "23:30"))).toBe(true);
  });
  it("returns null when hours are unknown", () => {
    expect(isOpenFor(null, jst("2026-10-07", "18:30"))).toBeNull();
  });
});

describe("free cancellation deadline", () => {
  it("hours before", () => {
    expect(freeCancelDeadline("2026-10-07", "18:30", { hoursBefore: 48 }).deadline.toISO()).toContain("2026-10-05T18:30");
  });
  it("days before at a cut-off time", () => {
    const { deadline, assumed } = freeCancelDeadline("2026-10-07", "18:30", { daysBefore: 2, atTime: "17:00" });
    expect(deadline.toISO()).toContain("2026-10-05T17:00");
    expect(assumed).toBe(false);
  });
  it("assumes 24h when the policy is unknown", () => {
    const { deadline, assumed } = freeCancelDeadline("2026-10-07", "18:30", null);
    expect(deadline.toISO()).toContain("2026-10-06T18:30");
    expect(assumed).toBe(true);
  });
});
