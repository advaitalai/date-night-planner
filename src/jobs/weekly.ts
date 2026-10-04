import { DateTime } from "luxon";
import { PEOPLE } from "../config";
import { kvGet, kvSet } from "../db";
import { activePlanFor, addVisit, getPlace, getPrefs, getReservation, updatePlan, updatePrefs, updateReservation } from "../db/repo";
import { cancelReservation, policyLine } from "../booking/service";
import { say } from "../notify";
import { bookOption, rankByVotes } from "../plans/decide";
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
  for (const [type, when] of [
    ["nudge", prefs.nudge],
    ["decide", prefs.decideBy],
  ] as const) {
    const at = nextWeeklyMoment(kickoff, when.weekday, when.time);
    if (at.toISODate()! < date) schedule(type, at, { date }, `${type}:${date}:${at.toISO()}`);
  }
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
    const missing = PEOPLE.filter((p) => !plan.votes[p]?.length);
    if (missing.length) await say(`Reminder: ${missing.join(" and ")} — vote for ${fmtDate(date)} in the poll above so I can lock a table in 🙏`);
  });

  registerJob("decide", async ({ date }: { date: string }) => {
    const plan = activePlanFor(date);
    if (!plan || plan.status !== "proposed") return;
    const anyVotes = Object.values(plan.votes).some((v) => v.length);
    if (!anyVotes) {
      await say(`No votes for ${fmtDate(date)} yet, so I haven't booked anything. Say "book option 1" (or 2/3), or "skip this week".`);
      return;
    }
    const top = rankByVotes(plan)[0];
    await say(`Deadline's up — booking the top-voted option, *${plan.options[top].name}*.`);
    await bookOption(plan.id, top);
  });

  registerJob("cancel_guard", async ({ reservationId, hours }: { reservationId: number; hours: number }) => {
    const r = getReservation(reservationId);
    if (!r || (r.status !== "confirmed" && r.status !== "requested")) return;
    const place = getPlace(r.place_id)!;
    const stillOn = kvGet<boolean>(`still_on:${r.id}`, false);
    if (hours === 48) {
      await say(`Still on for *${place.name}* on ${fmtDate(r.date)} at ${r.time}? ${policyLine(r)} Reply "still on", or "cancel" and I'll cancel it in time.`);
      return;
    }
    if (stillOn) return;
    if (getPrefs().autoCancel) {
      await say(await cancelReservation(r.id, "nobody confirmed before the free-cancellation deadline"));
      return;
    }
    await say(`⏰ Last call: free cancellation for *${place.name}* ends in about 24 hours. ${policyLine(r)} Reply "cancel" if plans changed.`);
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
    kvSet(`still_on:${r.id}`, null);
  });
}

/** For "skip next Wednesday" style requests. */
export function skipDate(date: string): void {
  const prefs = getPrefs();
  if (!prefs.skipWeeks.includes(date)) updatePrefs({ skipWeeks: [...prefs.skipWeeks, date] });
}
