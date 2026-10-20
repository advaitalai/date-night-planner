import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, place } from "./helpers";
import type { OpeningPeriod } from "../src/types";
import { ZONE } from "../src/util/time";

beforeEach(() => {
  freshDb();
  process.env.VAPI_API_KEY = "test";
  process.env.VAPI_PHONE_NUMBER_ID = "test";
});
afterEach(() => {
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.CALL_FAKE;
  vi.restoreAllMocks();
});

const slot = { date: "2026-10-21", time: "18:30", partySize: 2 };

/** Open in a few hours, closed right now. */
function closedNowHours(): OpeningPeriod[] {
  const o = DateTime.now().setZone(ZONE).plus({ hours: 3 });
  const c = o.plus({ hours: 3 });
  return [{ open: { day: o.weekday % 7, hour: o.hour, minute: 0 }, close: { day: c.weekday % 7, hour: c.hour, minute: 0 } }];
}

async function savedPhonePlace(overrides: Parameters<typeof place>[0] = {}) {
  const { insertPlace } = await import("../src/db/repo");
  const p = place({ name: "Warayaki", booking_channel: "phone", tablecheck_slug: null, phone: "03-1111-2222", ...overrides });
  const { id: _id, ...rest } = p;
  return insertPlace(rest);
}

const callCount = async () => {
  const { db } = await import("../src/db");
  return (db().prepare("SELECT COUNT(*) AS n FROM call_log").get() as { n: number }).n;
};

describe("phone calls need a go-ahead", () => {
  it("asks instead of calling when nobody has decided on the place", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { bookPlace } = await import("../src/booking/service");
    const { pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const out = await bookPlace(p, slot);
    expect(out.ok).toBe(false);
    expect(out.awaitingCall).toBe(true);
    expect(out.message).toContain("Shall I call them");
    expect(out.message).toContain("Reply to this message");
    expect(pendingCall()).toMatchObject({ kind: "book", placeId: p.id, slot });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls straight away once they've decided on a phone-only place", async () => {
    process.env.CALL_FAKE = "booked";
    const { bookPlace } = await import("../src/booking/service");
    const p = await savedPhonePlace();
    const out = await bookPlace(p, slot, { callApproved: true });
    expect(await callCount()).toBe(1);
    expect(out.message).toContain("Booked Warayaki");
    // What they said, and where the policy was looked for (not "policy not stated").
    expect(out.message).toContain("_They said: Fake call (CALL_FAKE): booked._");
    expect(out.message).toContain("(no policy on the call; assuming 24h)");
  });

  it("gives the agent the last call, so \"what did they say?\" gets the real answer", async () => {
    process.env.CALL_FAKE = "booked";
    const { bookPlace } = await import("../src/booking/service");
    const { lastCallNote } = await import("../src/logbook");
    expect(lastCallNote()).toBeNull();
    await bookPlace(await savedPhonePlace(), slot, { callApproved: true });
    const note = lastCallNote()!;
    expect(note).toContain("book call to Warayaki");
    expect(note).toContain("booked. Fake call (CALL_FAKE): booked.");
    expect(note).toContain("Transcript (start): [fake call:");
  });

  it("doesn't call a closed restaurant: says when they open and waits to be told", async () => {
    process.env.CALL_FAKE = "booked";
    const { bookPlace } = await import("../src/booking/service");
    const { pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace({ opening_periods: closedNowHours() });
    const out = await bookPlace(p, slot, { callApproved: true });
    expect(await callCount()).toBe(0);
    expect(out.message).toMatch(/closed right now and open/);
    expect(out.message).toContain("Reply to this message when you'd like me to call");
    expect(pendingCall()?.placeId).toBe(p.id);
  });

  it("place_call does nothing when no call is waiting", async () => {
    process.env.CALL_FAKE = "booked";
    const { tools } = await import("../src/agent/tools");
    const placeCall = tools.find((t) => t.name === "place_call")!;
    const out = await (placeCall.run as (i: unknown) => Promise<string>)({});
    expect(out).toMatch(/no call waiting/);
    expect(await callCount()).toBe(0);
  });

  it("'no' drops the waiting call", async () => {
    const { bookPlace } = await import("../src/booking/service");
    const { pendingCall } = await import("../src/booking/calls");
    const { tools } = await import("../src/agent/tools");
    await bookPlace(await savedPhonePlace(), slot);
    const decline = tools.find((t) => t.name === "decline_call")!;
    expect(await (decline.run as (i: unknown) => Promise<string>)({})).toMatch(/Dropped/);
    expect(pendingCall()).toBeNull();
  });
});

describe("after a call", () => {
  const report = (outcome: string, extra: Record<string, unknown> = {}) => ({
    outcome: { outcome, bookedTime: null, alternativeTimes: [], cancellationPolicy: null, requirements: null, summaryEn: "They said hello.", ...extra },
    transcript: "",
  });

  it("says what happened, what they said, and the times they offered", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("full", { alternativeTimes: ["19:00"] }) as never);
    expect(msg).toContain("full at 18:30");
    expect(msg).toContain("They said hello.");
    expect(msg).toContain("They offered *19:00*");
    expect(msg).toContain("try again");
    expect(pendingCall()?.alternatives).toEqual(["19:00"]);
  });

  it("keeps the call ready to retry when the line was busy", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    expect(outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("busy") as never)).toContain("busy");
    expect(pendingCall()?.placeId).toBe(p.id);
  });

  it("refuses course or card conditions without proposing another call", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("declined", { requirements: "a ¥12,000 course" }) as never);
    expect(msg).toContain("seats-only");
    expect(pendingCall()).toBeNull();
  });

  it("explains a call that never connected, with the fix", async () => {
    const { outcomeMessage } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, { ...report("failed"), failure: "Twilio balance is $0.12." } as never);
    expect(msg).toContain("couldn't place the call");
    expect(msg).toContain("Twilio balance is $0.12.");
  });
});

describe("reading how a call ended", () => {
  it("maps Vapi's ended reasons before reading the transcript", async () => {
    const { outcomeFromEndedReason } = await import("../src/booking/phone");
    expect(outcomeFromEndedReason("customer-busy", "")).toBe("busy");
    expect(outcomeFromEndedReason("customer-did-not-answer", "")).toBe("no_answer");
    expect(outcomeFromEndedReason("call.start.error-get-transport", "")).toBe("failed");
    expect(outcomeFromEndedReason("assistant-said-end-call-phrase", "AI: Hello")).toBeNull();
  });

  it("explains a Twilio transport failure in plain words", async () => {
    const { explainCallFailure } = await import("../src/booking/phone");
    const msg = await explainCallFailure("call.start.error-get-transport");
    expect(msg).toMatch(/Twilio didn't connect the call/);
  });
});

describe("debug logs", () => {
  it("keeps every booking attempt and call in the database", async () => {
    const { logAttempt, logCall } = await import("../src/logbook");
    const { db } = await import("../src/db");
    logAttempt({ placeId: 1, placeName: "h:armonia", date: "2026-10-14", time: "18:30", channel: "tablecheck", result: "full", detail: "18:30 is full" });
    logCall({ placeId: 1, placeName: "Warayaki", kind: "book", toNumber: "+81...", outcome: "busy", summary: "line busy", dryRun: true });
    expect((db().prepare("SELECT result FROM booking_log").get() as { result: string }).result).toBe("full");
    expect((db().prepare("SELECT outcome FROM call_log").get() as { outcome: string }).outcome).toBe("busy");
  });
});

describe("reminders", () => {
  it("schedules one 'still on?' a day before free cancellation ends, plus the day-of reminder", async () => {
    const { createReservation, getPlace } = await import("../src/db/repo");
    const { scheduleReservationJobs } = await import("../src/booking/service");
    const { pendingJobs } = await import("../src/jobs/scheduler");
    const p = await savedPhonePlace();
    const date = DateTime.now().setZone(ZONE).plus({ days: 5 }).toISODate()!;
    const r = createReservation({
      plan_id: null, place_id: getPlace(p.id)!.id, channel: "phone", status: "confirmed", date, time: "19:00", party_size: 2,
      external_ref: null, manage_url: null, gmail_thread_id: null, policy_text: null, free_cancel_deadline: DateTime.fromISO(`${date}T19:00`, { zone: ZONE }).minus({ hours: 24 }).toISO(), cancel_fee: null, notes: null,
    });
    scheduleReservationJobs(r);
    const types = pendingJobs().map((j) => j.type);
    expect(types.filter((t) => t === "cancel_guard")).toHaveLength(1);
    expect(types).toContain("dayof_reminder");
  });
});

describe("incidents from the 12–15 Oct retro", () => {
  it("never retries a reminder job (a delivered-but-timed-out send went out twice)", async () => {
    const { registerJob, schedule, runDueJobs } = await import("../src/jobs/scheduler");
    const { db } = await import("../src/db");
    registerJob("dayof_reminder", async () => {
      throw new Error("Timed Out");
    });
    schedule("dayof_reminder", DateTime.now().minus({ minutes: 1 }), {}, "dayof-test");
    await runDueJobs();
    expect((db().prepare("SELECT status FROM jobs WHERE dedupe_key = 'dayof-test'").get() as { status: string }).status).toBe("failed");
  });

  it("leaves out places Google marks as temporarily closed", async () => {
    const { applyFilters } = await import("../src/recommender/filters");
    const { EMPTY_CONSTRAINTS } = await import("../src/recommender/parseRequest");
    const c = { place: place({ features: { notOperating: "CLOSED_TEMPORARILY" } }), travelMin: 10, travelEstimated: false, openAtSlot: true, lastVisitDaysAgo: null };
    expect(applyFilters([c], EMPTY_CONSTRAINTS, { maxTravelMin: 25, revisitCooldownWeeks: 8, budgetPerPersonMaxJpy: 15000 }).rejected[0].reason).toBe("closed");
  });
});
