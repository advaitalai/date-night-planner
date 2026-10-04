import { DateTime } from "luxon";
import { detectChannel } from "../booking/detect";
import { tcSearchNear } from "../booking/tablecheck";
import type { Slot } from "../booking/types";
import { config } from "../config";
import { kvGet, kvSet } from "../db";
import { listPlaces, recentVisits, updatePlace, upsertPlace } from "../db/repo";
import { cidFromMapsUri, placeDetails, textSearch, toPlaceFields, travelMinutes } from "../places/google";
import { buildProfile } from "../places/profile";
import type { Place } from "../types";
import type { LatLng } from "../util/geo";
import { isOpenFor, jst, ZONE } from "../util/time";
import type { Candidate } from "./filters";
import type { Constraints } from "./parseRequest";

const REDETECT_DAYS = 30;

/** Fill in Google details, booking channel and profile where missing. Cached in the DB. */
export async function enrich(place: Place): Promise<Place> {
  let p = place;
  if (!config.google.mapsKey) return p;
  try {
    if (!p.google_place_id) {
      const results = await textSearch(`${p.name} Tokyo`, { lat: p.lat ?? 35.65, lng: p.lng ?? 139.72 }, 20000, 5);
      const hit = (p.cid && results.find((r) => cidFromMapsUri(r.googleMapsUri) === p.cid)) || results[0];
      if (hit) p = updatePlace(p.id, { ...toPlaceFields(hit.reviews ? hit : await placeDetails(hit.id)), name: p.name });
    }
    const detectedAt = kvGet<string | null>(`detect:${p.id}`, null);
    const stale = !detectedAt || DateTime.fromISO(detectedAt).plus({ days: REDETECT_DAYS }) < DateTime.now();
    if (p.booking_channel === "unknown" && stale) {
      const d = await detectChannel(p);
      p = updatePlace(p.id, { booking_channel: d.channel, ...d.patch });
      kvSet(`detect:${p.id}`, new Date().toISOString());
    }
    if (!p.profile && p.google_place_id && p.booking_channel !== "not_restaurant") p = await buildProfile(p);
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
export async function discover(k: Constraints, anchor: LatLng, slot: Slot, limit = 8): Promise<Place[]> {
  const found: Place[] = [];
  try {
    const shops = await tcSearchNear(anchor.lat, anchor.lng, slot, { distance: "3km" });
    const known = new Set(listPlaces("tablecheck_slug IS NOT NULL").map((p) => p.tablecheck_slug));
    for (const s of shops.filter((s) => !known.has(s.slug) && s.availableDates.includes(slot.date)).slice(0, limit)) {
      let fields: Partial<Place> = { lat: s.lat, lng: s.lng, cuisine: s.cuisines[0] ?? null };
      if (config.google.mapsKey && s.lat != null && s.lng != null) {
        const [g] = await textSearch(s.name, { lat: s.lat, lng: s.lng }, 300, 1).catch(() => []);
        if (g) fields = { ...toPlaceFields(g), cuisine: fields.cuisine ?? toPlaceFields(g).cuisine };
      }
      found.push(upsertPlace({ ...fields, name: s.name, source: "discovered", booking_channel: "tablecheck", tablecheck_slug: s.slug }));
    }
  } catch (err) {
    console.warn("TableCheck discovery failed:", (err as Error).message);
  }

  if (config.google.mapsKey) {
    try {
      const query = [...k.cuisines, ...k.vibe, "restaurant"].join(" ");
      for (const g of await textSearch(query, anchor, 2500, limit)) {
        found.push(upsertPlace({ ...toPlaceFields(g), name: g.displayName?.text ?? "?", source: "discovered" }));
      }
    } catch (err) {
      console.warn("Google discovery failed:", (err as Error).message);
    }
  }
  return found;
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
