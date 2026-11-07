import { bookAndAnnounce, checkAvailability, nearbyTimes } from "../booking/service";
import { getPlace, getPlan, updatePlan } from "../db/repo";
import { say, status } from "../notify";
import type { Slot } from "../booking/types";
import { pickInWindow } from "../booking/window";
import { fmtDate } from "../util/time";

/**
 * Book option `index` of a plan once the chat has decided on it: only that
 * place, never a different one without asking. If it's full or can't be
 * booked, say so and let them choose. Deciding on a phone-only place is the
 * go-ahead to call (unless they're closed: then it asks).
 */
export async function bookOption(planId: number, index: number): Promise<void> {
  const plan = getPlan(planId);
  if (!plan || plan.status !== "proposed") return;
  const place = getPlace(plan.options[index]?.placeId);
  if (!place) return;
  updatePlan(planId, { status: "booking" });
  let slot: Slot = { date: plan.date, time: plan.time, partySize: plan.party_size, ...(plan.time_latest ? { latest: plan.time_latest } : {}) };
  await status(`Checking the table at ${place.name}…`);
  const avail = await checkAvailability(place, slot);
  // Full at the asked time but free inside their window: take it without asking.
  const inWin = avail.status === "unavailable" ? pickInWindow(avail.alternatives, slot) : null;
  if (inWin) slot = { ...slot, time: inWin, asked: slot.time };
  else if (avail.status === "unavailable") {
    updatePlan(planId, { status: "proposed" });
    const near = nearbyTimes(avail.alternatives, slot.time);
    const alts = near.length ? `\nFree that evening: *${near.join(", ")}*.` : "\nNothing free that evening.";
    await say(`❌ *${place.name}* is full at ${slot.time} on ${fmtDate(slot.date)}.${alts}\n\n${near.length ? "Want one of those times, or another option?" : "Want another option, or another day?"}`);
    return;
  }
  const out = await bookAndAnnounce(place, slot, { planId, callApproved: true });
  // Not booked (full, failed, or waiting for a go-ahead to call): the proposal stays open.
  if (!out.ok) updatePlan(planId, { status: "proposed" });
}
