/**
 * Stories that had no test (20 Oct): change a booking, book a place you name,
 * the visit log, changing settings in chat, the status line, "tell me more".
 * No network, no AI: TableCheck is stubbed and calls are faked.
 */
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, place } from "./helpers";
import { ZONE } from "../src/util/time";

const date = DateTime.now().setZone(ZONE).plus({ days: 5 }).toISODate()!;
let restoreTc: (() => void) | undefined;

beforeEach(() => {
  freshDb();
  process.env.VAPI_API_KEY = "test";
  process.env.VAPI_PHONE_NUMBER_ID = "test";
});
afterEach(() => {
  restoreTc?.();
  restoreTc = undefined;
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.CALL_FAKE;
});

/** Replace TableCheck's network calls for one test. */
async function stubTableCheck(stub: Partial<typeof import("../src/booking/tablecheck").tablecheck>) {
  const { tablecheck } = await import("../src/booking/tablecheck");
  const saved = { ...tablecheck };
  Object.assign(tablecheck, stub);
  restoreTc = () => Object.assign(tablecheck, saved);
}

async function saved(overrides: Parameters<typeof place>[0] = {}) {
  const { insertPlace } = await import("../src/db/repo");
  const { id: _id, ...rest } = place(overrides);
  return insertPlace(rest);
}

async function booking(placeId: number, channel: "tablecheck" | "phone") {
  const { createReservation } = await import("../src/db/repo");
  return createReservation({
    plan_id: null, place_id: placeId, channel, status: "confirmed", date, time: "18:30", party_size: 2,
    external_ref: null, manage_url: null, gmail_thread_id: null, policy_text: null,
    free_cancel_deadline: DateTime.fromISO(`${date}T18:30`, { zone: ZONE }).minus({ hours: 24 }).toISO(), cancel_fee: null, notes: null,
  });
}

const count = async (table: string) => {
  const { db } = await import("../src/db");
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
};

describe("change a booking", () => {
  it("on TableCheck: checks the new time is free, changes it, and moves the reminders", async () => {
    let changedTo = "";
    await stubTableCheck({
      checkAvailability: async () => ({ status: "available" }),
      modify: async (_r, _p, slot) => ((changedTo = slot.time), { ok: true }),
    });
    const { modifyReservation } = await import("../src/booking/service");
    const { getReservation } = await import("../src/db/repo");
    const { pendingJobs } = await import("../src/jobs/scheduler");
    const p = await saved({ name: "h:armonia" });
    const r = await booking(p.id, "tablecheck");
    const msg = await modifyReservation(r.id, { time: "19:30" });
    expect(msg).toContain("Changed h:armonia");
    expect(msg).toContain("19:30");
    expect(changedTo).toBe("19:30");
    expect(getReservation(r.id)!.time).toBe("19:30");
    expect(pendingJobs().some((j) => j.type === "dayof_reminder")).toBe(true);
  });

  it("on TableCheck: a full new time changes nothing and says what's free", async () => {
    let modified = false;
    await stubTableCheck({
      checkAvailability: async () => ({ status: "unavailable", alternatives: ["20:00"] }),
      modify: async () => ((modified = true), { ok: true }),
    });
    const { modifyReservation } = await import("../src/booking/service");
    const { getReservation } = await import("../src/db/repo");
    const p = await saved({ name: "h:armonia" });
    const r = await booking(p.id, "tablecheck");
    const msg = await modifyReservation(r.id, { time: "19:30" });
    expect(msg).toMatch(/no table at 19:30/);
    expect(msg).toContain("20:00");
    expect(modified).toBe(false);
    expect(getReservation(r.id)!.time).toBe("18:30");
  });

  it("by phone: asks first, then one call changes it", async () => {
    process.env.CALL_FAKE = "booked";
    const { modifyReservation } = await import("../src/booking/service");
    const { getReservation } = await import("../src/db/repo");
    const p = await saved({ name: "Suan Sawan", booking_channel: "phone", tablecheck_slug: null, phone: "03-0000-0000" });
    const r = await booking(p.id, "phone");
    const ask = await modifyReservation(r.id, { time: "19:15" });
    expect(ask).toContain("Shall I call them to change the booking");
    expect(await count("call_log")).toBe(0);
    const done = await modifyReservation(r.id, { time: "19:15" }, { callApproved: true });
    expect(done).toContain("Changed Suan Sawan");
    expect(await count("call_log")).toBe(1);
    expect(getReservation(r.id)!.time).toBe("19:15");
  });
});

describe("book a place you name", () => {
  it("books only that place, at the time asked", async () => {
    const tried: string[] = [];
    await stubTableCheck({
      checkAvailability: async () => ({ status: "available" }),
      book: async (pl, slot) => (tried.push(`${pl.name} ${slot.time}`), { status: "confirmed", externalRef: "TC-1" }),
    });
    const { tools } = await import("../src/agent/tools");
    const { upcomingReservations } = await import("../src/db/repo");
    await saved({ name: "SMOKEHOUSE", tablecheck_slug: "smokehouse" });
    await saved({ name: "bills Omotesando", tablecheck_slug: "bills" });
    const bookPlace = tools.find((t) => t.name === "book_place")!;
    await (bookPlace.run as (i: unknown) => Promise<string>)({ place_name: "SMOKEHOUSE", date, time: "19:00" });
    expect(tried).toEqual(["SMOKEHOUSE 19:00"]);
    const rs = upcomingReservations(DateTime.now().setZone(ZONE).toISODate()!);
    expect(rs).toHaveLength(1);
    expect(rs[0].time).toBe("19:00");
  });

  it("when it's full, says so and books nothing", async () => {
    let booked = false;
    await stubTableCheck({
      checkAvailability: async () => ({ status: "unavailable", alternatives: ["21:00"] }),
      book: async () => ((booked = true), { status: "confirmed" }),
    });
    const { tools } = await import("../src/agent/tools");
    await saved({ name: "SMOKEHOUSE", tablecheck_slug: "smokehouse" });
    const bookPlace = tools.find((t) => t.name === "book_place")!;
    const out = await (bookPlace.run as (i: unknown) => Promise<string>)({ place_name: "SMOKEHOUSE", date, time: "19:00", latest_time: "19:00" });
    expect(out).toMatch(/full at 19:00/);
    expect(booked).toBe(false);
    expect(await count("reservations")).toBe(0);
  });
});

describe("visit log", () => {
  it("the morning after, marks the booking done and logs the visit for rotation", async () => {
    const { registerReminderJobs } = await import("../src/jobs/reminders");
    const { schedule, runDueJobs } = await import("../src/jobs/scheduler");
    const { getReservation, recentVisits } = await import("../src/db/repo");
    registerReminderJobs();
    const p = await saved({ name: "Suan Sawan", cuisine: "thai" });
    const r = await booking(p.id, "phone");
    schedule("post_date", DateTime.now().minus({ minutes: 1 }), { reservationId: r.id }, "post-test");
    await runDueJobs();
    expect(getReservation(r.id)!.status).toBe("done");
    expect(recentVisits().map((v) => v.place_id)).toEqual([p.id]);
  });

  it("logs nothing for a cancelled booking", async () => {
    const { registerReminderJobs } = await import("../src/jobs/reminders");
    const { schedule, runDueJobs } = await import("../src/jobs/scheduler");
    const { recentVisits, updateReservation } = await import("../src/db/repo");
    registerReminderJobs();
    const p = await saved({ name: "Suan Sawan" });
    const r = await booking(p.id, "phone");
    updateReservation(r.id, { status: "cancelled" });
    schedule("post_date", DateTime.now().minus({ minutes: 1 }), { reservationId: r.id }, "post-cancelled");
    await runDueJobs();
    expect(recentVisits()).toHaveLength(0);
  });
});

describe("change settings in chat", () => {
  it("updates the usual day, time, budget and travel limit", async () => {
    const { tools } = await import("../src/agent/tools");
    const { getPrefs } = await import("../src/db/repo");
    const update = tools.find((t) => t.name === "update_preferences")!;
    await (update.run as (i: unknown) => Promise<string>)({ defaultWeekday: 5, defaultTime: "19:00", budgetPerPersonMaxJpy: 8000, maxTravelMin: 20 });
    expect(getPrefs()).toMatchObject({ defaultWeekday: 5, defaultTime: "19:00", budgetPerPersonMaxJpy: 8000, maxTravelMin: 20 });
  });
});

describe("status line", () => {
  it("is one message, edited as work progresses, removed at the end", async () => {
    const { setSender, status, clearStatus } = await import("../src/notify");
    const log: string[] = [];
    setSender({
      text: async (t) => (log.push(`send ${t}`), "s1"),
      edit: async (_id, t) => void log.push(`edit ${t}`),
      remove: async (id) => void log.push(`remove ${id}`),
    });
    await status("Checking the table…");
    await status("Booking it…");
    await status("Booking it…");
    await clearStatus();
    expect(log).toEqual(["send ⏳ Checking the table…", "edit ⏳ Booking it…", "remove s1"]);
  });
});

describe("status line freshness", () => {
  it("never edits a status line that has scrolled away: removes it and posts a new one", async () => {
    const { vi } = await import("vitest");
    const { setSender, status, clearStatus } = await import("../src/notify");
    const log: string[] = [];
    let n = 0;
    setSender({
      text: async (t) => (log.push(`send ${t}`), `s${++n}`),
      edit: async (id, t) => void log.push(`edit ${id} ${t}`),
      remove: async (id) => void log.push(`remove ${id}`),
    });
    vi.useFakeTimers();
    await status("Searching places…");
    vi.advanceTimersByTime(4 * 60_000); // left behind 4 min ago
    await status("Checking the table and booking…");
    vi.useRealTimers();
    await clearStatus();
    expect(log).toEqual(["send ⏳ Searching places…", "remove s1", "send ⏳ Checking the table and booking…", "remove s2"]);
  });
});

describe("tell me more", () => {
  it("returns the option's facts and how it would be booked", async () => {
    const { tools } = await import("../src/agent/tools");
    const { createPlan } = await import("../src/db/repo");
    const p = await saved({ name: "h:armonia", cuisine: "italian", address: "Nishigotanda", rating: 4.6 });
    createPlan({ date, time: "18:30", party_size: 2, status: "proposed", request: null, options: [{ placeId: p.id, name: p.name, availability: "unchecked", pitch: "Handmade pasta", score: 1 }] });
    const details = tools.find((t) => t.name === "option_details")!;
    const out = await (details.run as (i: unknown) => Promise<string>)({ option_number: 1 });
    expect(out).toContain("h:armonia");
    expect(out).toContain("Google 4.6");
    expect(out).toContain("Handmade pasta");
    expect(out).toMatch(/How I'd book it: online on TableCheck/);
  });
});
