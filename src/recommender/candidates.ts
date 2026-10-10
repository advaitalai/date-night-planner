import { DateTime } from "luxon";
import { detectChannel } from "../booking/detect";
import { tcSearchNear } from "../booking/tablecheck";
import type { Slot } from "../booking/types";
import { config } from "../config";
import { kvGet, kvSet } from "../db";
import { listPlaces, recentVisits, updatePlace, upsertPlace } from "../db/repo";
import { cidFromMapsUri, textSearch, toPlaceFields, travelMinutes } from "../places/google";
import { buildProfile } from "../places/profile";
import type { Place } from "../types";
import type { LatLng } from "../util/geo";
import { isOpenFor, jst, ZONE } from "../util/time";
import type { Candidate } from "./filters";
import type { Constraints } from "./parseRequest";

const REDETECT_DAYS = 30;

/**
 * Fill in Google details (and the review-based profile unless `lite`).
 * Booking-channel detection is left to booking time, so recommending stays fast.
 */
export async function enrich(place: Place, opts: { lite?: boolean } = {}): Promise<Place> {
  let p = place;
  if (!config.google.mapsKey) return p;
  try {
    if (!p.google_place_id) {
      const results = await textSearch(`${p.name} Tokyo`, { lat: p.lat ?? 35.65, lng: p.lng ?? 139.72 }, 20000, 5);
      const hit = (p.cid && results.find((r) => cidFromMapsUri(r.googleMapsUri) === p.cid)) || results[0];
      if (hit) p = updatePlace(p.id, { ...toPlaceFields(hit), name: p.name });
    }
    if (!opts.lite && !p.profile && p.google_place_id && p.booking_channel !== "not_restaurant") p = await buildProfile(p);
  } catch (err) {
    console.warn(`enrich ${p.name}:`, (err as Error).message);
  }
  return p;
}

/**
 * Find new places beyond the saved lists: TableCheck shops near the anchor
 * that have availability for the slot (bookable by construction), plus a
 * Google text search for the requested cuisine/vibe.
 */
/**
 * New places beyond the saved lists: TableCheck shops with tables at that time,
 * plus Google searches for the requested cuisine/vibe (or good restaurants in
 * general) within the travel radius.
 */
export async function discover(k: Constraints, anchor: LatLng, slot: Slot, radiusM = 3000, limit = 20): Promise<Place[]> {
  const found: Place[] = [];
  try {
    const shops = await tcSearchNear(anchor.lat, anchor.lng, slot, { distance: `${Math.round(radiusM / 1000)}km` });
    const known = new Set(listPlaces("tablecheck_slug IS NOT NULL").map((p) => p.tablecheck_slug));
    for (const s of shops.filter((s) => !known.has(s.slug) && s.availableDates.includes(slot.date)).slice(0, limit)) {
      let fields: Partial<Place> = { lat: s.lat, lng: s.lng, cuisine: s.cuisines[0] ?? null };
      if (config.google.mapsKey && s.lat != null && s.lng != null) {
        const [g] = await textSearch(s.name, { lat: s.lat, lng: s.lng }, 300, 1).catch(() => []);
        if (g) fields = { ...toPlaceFields(g), cuisine: fields.cuisine ?? toPlaceFields(g).cuisine };
      }
      // TableCheck's average dinner spend is a better budget signal than Google's ¥–¥¥¥¥.
      if (s.budgetDinnerAvg != null) fields.price_level = priceLevelForJpy(s.budgetDinnerAvg);
      found.push(upsertPlace({ ...fields, name: s.name, source: "discovered", booking_channel: "tablecheck", tablecheck_slug: s.slug }));
    }
  } catch (err) {
    console.warn("TableCheck discovery failed:", (err as Error).message);
  }

  if (config.google.mapsKey) {
    try {
      const queries = k.cuisines.length
        ? k.cuisines.map((c) => [c, ...k.vibe, "restaurant"].join(" "))
        : [[...k.vibe, "restaurant"].join(" "), "date night restaurant"];
      for (const q of queries) {
        for (const g of await textSearch(q, anchor, radiusM, limit)) {
          found.push(upsertPlace({ ...toPlaceFields(g), name: g.displayName?.text ?? "?", source: "discovered" }));
        }
      }
    } catch (err) {
      console.warn("Google discovery failed:", (err as Error).message);
    }
  }
  return found;
}

/** Map an average spend per person to the same 1–4 scale the filters use (see PRICE_LEVEL_JPY). */
export function priceLevelForJpy(jpy: number): number {
  if (jpy <= 2500) return 1;
  if (jpy <= 6000) return 2;
  if (jpy <= 15000) return 3;
  return 4;
}

/** Saved places (both lists) plus anything discovered earlier. */
export function savedPool(): Place[] {
  return listPlaces("booking_channel != 'not_restaurant'");
}

export async function toCandidate(place: Place, anchor: LatLng, slot: Slot): Promise<Candidate | null> {
  if (place.lat == null || place.lng == null) return null;
  const start = jst(slot.date, slot.time);
  const travel = await travelMinutes(anchor, { lat: place.lat, lng: place.lng }, start.toJSDate());
  const lastVisit = recentVisits(200).find((v) => v.place_id === place.id);
  return {
    place,
    travelMin: travel.minutes,
    travelEstimated: travel.estimated,
    openAtSlot: isOpenFor(place.opening_periods, start),
    lastVisitDaysAgo: lastVisit ? Math.floor(start.diff(DateTime.fromISO(lastVisit.date, { zone: ZONE }), "days").days) : null,
  };
}
