import { SELF_BOOKABLE, type Place } from "../types";
import type { Constraints } from "./parseRequest";
import { cuisineMatch, cuisineOf, priceLevelOf } from "./similarity";

export interface Candidate {
  place: Place;
  travelMin: number;
  travelEstimated: boolean;
  openAtSlot: boolean | null;
  lastVisitDaysAgo: number | null;
}

export interface FilterSettings {
  maxTravelMin: number;
  revisitCooldownWeeks: number;
  budgetPerPersonMaxJpy: number | null;
}

/** Rough dinner spend per person for a Google price level / profile band. */
export const PRICE_LEVEL_JPY: Record<number, number> = { 0: 0, 1: 1500, 2: 4000, 3: 9000, 4: 20000 };

export type RejectReason = "not_bookable" | "too_far" | "closed" | "visited_recently" | "over_budget" | "cuisine" | "excluded";

export interface FilterResult {
  kept: Candidate[];
  rejected: { candidate: Candidate; reason: RejectReason }[];
}

function nameMatches(place: Place, names: string[]): boolean {
  const n = place.name.toLowerCase();
  return names.some((x) => n.includes(x.toLowerCase()) || x.toLowerCase().includes(n));
}

/**
 * Whether the bot has any way to try booking: a booking site, an email
 * address, or a phone number for an AI call. Walk-in-only places don't count.
 */
export function canAttemptBooking(p: Place): boolean {
  if (p.booking_channel === "walkin" || p.booking_channel === "not_restaurant") return false;
  return Boolean(p.tablecheck_slug || p.tabelog_url || p.booking_email || p.phone || SELF_BOOKABLE.includes(p.booking_channel));
}

export function rejectReason(c: Candidate, k: Constraints, s: FilterSettings): RejectReason | null {
  const p = c.place;
  if (nameMatches(p, k.excludePlaces)) return "excluded";
  if (!canAttemptBooking(p)) return "not_bookable";
  if (c.openAtSlot === false) return "closed";
  if (c.travelMin > (k.maxTravelMin ?? s.maxTravelMin)) return "too_far";
  if (c.lastVisitDaysAgo != null && c.lastVisitDaysAgo < s.revisitCooldownWeeks * 7) return "visited_recently";
  const budget = k.budgetPerPersonMaxJpy ?? s.budgetPerPersonMaxJpy;
  const level = priceLevelOf(p);
  if (budget != null && level != null && PRICE_LEVEL_JPY[level] > budget * 1.2) return "over_budget";
  const cuisine = cuisineOf(p);
  if (k.avoidCuisines.some((a) => cuisineMatch(cuisine, a) > 0)) return "cuisine";
  if (k.cuisines.length && !k.cuisines.some((w) => cuisineMatch(cuisine, w) > 0)) return "cuisine";
  return null;
}

export function applyFilters(cands: Candidate[], k: Constraints, s: FilterSettings): FilterResult {
  const out: FilterResult = { kept: [], rejected: [] };
  for (const c of cands) {
    const reason = rejectReason(c, k, s);
    if (reason) out.rejected.push({ candidate: c, reason });
    else out.kept.push(c);
  }
  return out;
}
