import { SELF_BOOKABLE, type Place, type PlaceFeatures } from "../types";
import type { Constraints, Feature } from "./parseRequest";
import { cuisineMatch, cuisineOf, priceLevelOf } from "./similarity";

export interface Candidate {
  place: Place;
  travelMin: number;
  travelEstimated: boolean;
  /** Close enough that travelMin is a walk, not transit. */
  travelWalk?: boolean;
  openAtSlot: boolean | null;
  lastVisitDaysAgo: number | null;
}

export interface FilterSettings {
  maxTravelMin: number;
  revisitCooldownWeeks: number;
  budgetPerPersonMaxJpy: number | null;
  /** Places already suggested for this date (left out when they ask for new options). */
  excludeIds?: Set<number>;
}

/** Rough dinner spend per person for a Google price level / profile band. */
export const PRICE_LEVEL_JPY: Record<number, number> = { 0: 0, 1: 1500, 2: 4000, 3: 9000, 4: 20000 };

export type RejectReason =
  | "not_bookable"
  | "too_far"
  | "closed"
  | "visited_recently"
  | "over_budget"
  | "cuisine"
  | "excluded"
  | "shown_before"
  | "not_dinner"
  | "missing_feature";

/** Google attribute behind each must-have, and words that show it in reviews/profiles. */
export const FEATURE_INFO: Record<Feature, { key: keyof PlaceFeatures; label: string; words: RegExp; query: string }> = {
  live_music: { key: "liveMusic", label: "live music", words: /live (music|jazz|band|performance)|jazz (club|bar)|ライブ/i, query: "live music restaurant" },
  outdoor_seating: { key: "outdoorSeating", label: "outdoor seating", words: /terrace|outdoor|patio|rooftop|テラス/i, query: "terrace restaurant" },
  cocktails: { key: "servesCocktails", label: "cocktails", words: /cocktail/i, query: "cocktail bar dinner" },
  wine: { key: "servesWine", label: "wine", words: /\bwine\b|ワイン/i, query: "wine bar dinner" },
  vegetarian: { key: "servesVegetarianFood", label: "vegetarian options", words: /vegetarian|vegan|plant-based/i, query: "vegetarian restaurant" },
};

/** True / false from Google's attribute, else whether reviews mention it, else unknown (null). */
export function hasFeature(p: Place, f: Feature): boolean | null {
  const info = FEATURE_INFO[f];
  const attr = p.features?.[info.key];
  if (attr === true) return true;
  const text = [...(p.profile?.vibeTags ?? []), ...(p.profile?.highlights ?? []), p.profile?.summary ?? ""].join(" ");
  if (info.words.test(text)) return true;
  return attr === false ? false : null;
}

const NOT_DINNER_TYPES = new Set(["dessert_shop", "dessert_restaurant", "cake_shop", "pastry_shop", "cafe", "coffee_shop", "bakery", "confectionery", "ice_cream_shop", "tea_house", "donut_shop", "candy_store", "chocolate_shop", "juice_shop"]);
const NOT_DINNER_WORDS = /dessert|sweets|patisserie|pâtisserie|parfait|cafe|café|coffee|bakery|kakigori|甘味|スイーツ/i;

/** Dessert bars, cafés and bakeries aren't dinner, unless that's what they asked for. */
export function isDinnerPlace(p: Place, k: Constraints): boolean {
  if (k.cuisines.some((c) => NOT_DINNER_WORDS.test(c))) return true;
  if (p.features?.servesDinner === false) return false;
  if (p.primary_type && NOT_DINNER_TYPES.has(p.primary_type)) return false;
  const label = `${p.cuisine ?? ""} ${p.profile?.cuisine ?? ""}`;
  return !NOT_DINNER_WORDS.test(label);
}

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
  if (s.excludeIds?.has(p.id)) return "shown_before";
  if (p.features?.notOperating) return "closed";
  if (!isDinnerPlace(p, k)) return "not_dinner";
  if (k.features.some((f) => hasFeature(p, f) !== true)) return "missing_feature";
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
