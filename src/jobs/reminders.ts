import { addVisit, getPlace, getReservation, updatePlan, updateReservation } from "../db/repo";
import { policyLine } from "../booking/service";
import { say } from "../notify";
import { cuisineOf } from "../recommender/similarity";
import { fmtDate } from "../util/time";
import { registerJob } from "./scheduler";

/**
 * Reminders for every booking, however it was made: one "still on?" a day
 * before free cancellation ends, the day-of reminder, and the visit log the
 * morning after. (Scheduled per booking in booking/service.ts.) There is no
 * weekly trigger: planning starts when one of them asks (cut 20 Oct).
 */
export function registerReminderJobs(): void {
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
