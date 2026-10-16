import { DateTime } from "luxon";
import { activePlanFor, addVisit, getPlace, getPrefs, getReservation, updatePlan, updatePrefs, updateReservation } from "../db/repo";
import { policyLine } from "../booking/service";
import { say } from "../notify";
import { proposePlan } from "../recommender";
import { cuisineOf } from "../recommender/similarity";
import { fmtDate, nextWeeklyMoment, nextWeekday, now } from "../util/time";
import { registerJob, schedule } from "./scheduler";

/**
 * The weekly rhythm. Each run schedules the next one; ensureWeeklyJobs() is
 * also called on startup and after preference changes, and dedupe keys keep
 * it idempotent.
 */

/** The date night a planning round starting at `from` is for. */
export function targetDate(from: DateTime): string {
  return nextWeekday(from, getPrefs().defaultWeekday);
}

export function ensureWeeklyJobs(from = now()): void {
  const prefs = getPrefs();
  const kickoff = nextWeeklyMoment(from, prefs.kickoff.weekday, prefs.kickoff.time);
  const date = targetDate(kickoff);
  schedule("kickoff", kickoff, { date }, `kickoff:${date}:${kickoff.toISO()}`);
  const nudge = nextWeeklyMoment(kickoff, prefs.nudge.weekday, prefs.nudge.time);
  if (nudge.toISODate()! < date) schedule("nudge", nudge, { date }, `nudge:${date}:${nudge.toISO()}`);
}

export function registerWeeklyJobs(): void {
  registerJob("kickoff", async ({ date }: { date: string }) => {
    try {
      const prefs = getPrefs();
      if (prefs.skipWeeks.includes(date)) {
        await say(`No date night planned for ${fmtDate(date)} (you asked me to skip it).`);
        return;
      }
      if (activePlanFor(date)) return; // already planned or booked earlier in the week
      await proposePlan("", { date });
    } finally {
      ensureWeeklyJobs(now().plus({ minutes: 1 }));
    }
  });

  registerJob("nudge", async ({ date }: { date: string }) => {
    const plan = activePlanFor(date);
    if (!plan || plan.status !== "proposed") return;
    // Nothing is ever booked without a decision: this only reminds.
    await say(`⏰ *Reminder:* no pick yet for ${fmtDate(date)}.\nReply to the options with the one you want, or tell me what you'd prefer.`);
  });

  // A day before free cancellation ends. It never cancels by itself.
  registerJob("cancel_guard", async ({ reservationId }: { reservationId: number }) => {
    const r = getReservation(reservationId);
    if (!r || (r.status !== "confirmed" && r.status !== "requested")) return;
    const place = getPlace(r.place_id)!;
    await say(`Still on for *${place.name}* on ${fmtDate(r.date)} at ${r.time}?\n\nAbout 24 hours of free cancellation left. ${policyLine(r)}\n\nReply to this message to cancel or change it.`);
  });

  registerJob("dayof_reminder", async ({ reservationId }: { reservationId: number }) => {
    const r = getReservation(reservationId);
    if (!r || r.status !== "confirmed") return;
    const place = getPlace(r.place_id)!;
    await say(`Tonight 🥂 *${place.name}* at ${r.time}${r.external_ref ? ` (ref ${r.external_ref})` : ""}.${place.address ? `\n${place.address}` : ""}${place.maps_url ? `\n${place.maps_url}` : ""}`);
  });

  registerJob("post_date", async ({ reservationId }: { reservationId: number }) => {
    const r = getReservation(reservationId);
    if (!r || r.status !== "confirmed") return;
    const place = getPlace(r.place_id)!;
    updateReservation(r.id, { status: "done" });
    addVisit(place.id, r.date, cuisineOf(place));
    if (r.plan_id) updatePlan(r.plan_id, { status: "done" });
  });
}

/** For "skip next Wednesday" style requests. */
export function skipDate(date: string): void {
  const prefs = getPrefs();
  if (!prefs.skipWeeks.includes(date)) updatePrefs({ skipWeeks: [...prefs.skipWeeks, date] });
}
