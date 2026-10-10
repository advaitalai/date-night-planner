import { bookAndAnnounce, checkAvailability } from "../booking/service";
import { voters } from "../config";
import { getPlace, getPlan, updatePlan } from "../db/repo";
import { say } from "../notify";
import type { Plan } from "../types";

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
 * Book option `index` of a plan. Availability is re-checked first (the poll
 * may be a day old); if it's gone, move to the next option in vote order.
 */
export async function bookOption(planId: number, index: number): Promise<void> {
  const plan = getPlan(planId);
  if (!plan || plan.status !== "proposed") return;
  updatePlan(planId, { status: "booking" });
  const order = [index, ...rankByVotes(plan).filter((i) => i !== index)];
  const slot = { date: plan.date, time: plan.time, partySize: plan.party_size };

  for (const i of order) {
    const place = getPlace(plan.options[i].placeId);
    if (!place) continue;
    const avail = await checkAvailability(place, slot);
    if (avail.status === "unavailable") {
      await say(`${place.name} just filled up for ${slot.time}${avail.alternatives?.length ? ` (free: ${avail.alternatives.join(", ")})` : ""}. Trying the next option…`);
      continue;
    }
    const out = await bookAndAnnounce(place, slot, { planId });
    if (out.ok) return;
  }
  updatePlan(planId, { status: "proposed" });
  await say("I couldn't book any of the options 😕 Tell me what to try instead (another time, day or area).");
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
    await say(`Split vote — ${desc}. Settle it in the poll or tell me which one; otherwise I'll book the top-voted option on Sunday evening.`);
  }
}
