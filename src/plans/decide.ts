import { bookAndAnnounce, checkAvailability, nearbyTimes } from "../booking/service";
import { voters } from "../config";
import { getPlace, getPlan, updatePlan } from "../db/repo";
import { say, status } from "../notify";
import type { Plan } from "../types";
import type { Slot } from "../booking/types";
import { pickInWindow } from "../booking/window";
import { fmtDate } from "../util/time";

/** Option indexes ordered by votes, ties broken by the recommender's ranking (lower index). */
export function rankByVotes(plan: Plan): number[] {
  const counts = plan.options.map(() => 0);
  for (const picks of Object.values(plan.votes)) for (const i of picks) if (i in counts) counts[i]++;
  return counts.map((c, i) => ({ c, i })).sort((a, b) => b.c - a.c || a.i - b.i).map((x) => x.i);
}

/** The option both people picked, if they agree. */
export function consensus(plan: Plan): number | null {
  const picks = voters().map((p) => plan.votes[p]);
  if (picks.some((v) => !v || v.length !== 1)) return null;
  return picks.every((v) => v[0] === picks[0][0]) ? picks[0][0] : null;
}

/**
 * Book option `index` of a plan: only that place, never a different one
 * without asking. If it's full or can't be booked, say so and let them choose.
 */
export async function bookOption(planId: number, index: number, opts: { callApproved?: boolean } = {}): Promise<void> {
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
  const out = await bookAndAnnounce(place, slot, { planId, callApproved: opts.callApproved });
  // Not booked (full, failed, or waiting for a go-ahead to call): the proposal stays open.
  if (!out.ok) updatePlan(planId, { status: "proposed" });
}

/** Record poll votes; book straight away when both people pick the same option. */
export async function onVotes(planId: number, votes: Record<string, number[]>): Promise<void> {
  const plan = updatePlan(planId, { votes });
  if (plan.status !== "proposed") return;
  const agreed = consensus(plan);
  if (agreed != null) {
    await say(`${voters().length > 1 ? "You both picked" : "You picked"} *${plan.options[agreed].name}* 🎉 Booking it now…`);
    await bookOption(planId, agreed);
    return;
  }
  const voted = voters().filter((p) => plan.votes[p]?.length);
  if (voted.length === voters().length) {
    const desc = voters().map((p) => `${p}: ${plan.votes[p].map((i) => plan.options[i].name).join(" / ")}`).join(", ");
    await say(`Split vote: ${desc}. Tell me which one; otherwise I'll book the top-voted option on Sunday evening.`);
  }
}
