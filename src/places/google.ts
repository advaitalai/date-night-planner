import { config } from "../config";
import type { OpeningPeriod, Place } from "../types";
import { estimateTravelMin, type LatLng } from "../util/geo";

const PLACES = "https://places.googleapis.com/v1";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * Searches skip reviews/editorial summary so they bill at the cheaper search
 * tier; place details (used once per place for its profile) include them.
 */
const SEARCH_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "types",
  "primaryType",
  "priceLevel",
  "rating",
  "userRatingCount",
  "regularOpeningHours",
  "websiteUri",
  "nationalPhoneNumber",
  "reservable",
  "googleMapsUri",
];

const DETAIL_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "types",
  "primaryType",
  "priceLevel",
  "rating",
  "userRatingCount",
  "regularOpeningHours",
  "websiteUri",
  "nationalPhoneNumber",
  "reservable",
  "editorialSummary",
  "reviews",
  "googleMapsUri",
];

export interface GPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  primaryType?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { periods?: OpeningPeriod[] };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  reservable?: boolean;
  editorialSummary?: { text: string };
  reviews?: { rating?: number; text?: { text: string }; originalText?: { text: string } }[];
  googleMapsUri?: string;
}

function requireKey(): string {
  if (!config.google.mapsKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");
  return config.google.mapsKey;
}

async function placesPost(path: string, body: unknown, fields: string[]): Promise<{ places?: GPlace[] }> {
  const res = await fetch(`${PLACES}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": requireKey(),
      "X-Goog-FieldMask": fields.map((f) => `places.${f}`).join(","),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Places ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as { places?: GPlace[] };
}

export async function textSearch(query: string, near: LatLng, radiusM = 5000, max = 10): Promise<GPlace[]> {
  const data = await placesPost(
    "places:searchText",
    {
      textQuery: query,
      languageCode: "en",
      regionCode: "JP",
      pageSize: max,
      locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: radiusM } },
    },
    SEARCH_FIELDS,
  );
  return data.places ?? [];
}

export async function nearbyRestaurants(near: LatLng, radiusM: number, types = ["restaurant"], max = 20): Promise<GPlace[]> {
  const data = await placesPost(
    "places:searchNearby",
    {
      includedTypes: types,
      maxResultCount: max,
      languageCode: "en",
      rankPreference: "POPULARITY",
      locationRestriction: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: radiusM } },
    },
    SEARCH_FIELDS,
  );
  return data.places ?? [];
}

export async function placeDetails(placeId: string): Promise<GPlace> {
  const res = await fetch(`${PLACES}/places/${placeId}?languageCode=en`, {
    headers: { "X-Goog-Api-Key": requireKey(), "X-Goog-FieldMask": DETAIL_FIELDS.join(",") },
  });
  if (!res.ok) throw new Error(`Place details ${res.status}: ${await res.text()}`);
  return (await res.json()) as GPlace;
}

export async function geocode(address: string): Promise<LatLng | null> {
  const [hit] = await textSearch(address, { lat: 35.68, lng: 139.76 }, 30000, 1);
  return hit?.location ? { lat: hit.location.latitude, lng: hit.location.longitude } : null;
}

/** Transit minutes via the Routes API, falling back to a distance estimate. */
export async function travelMinutes(from: LatLng, to: LatLng, arriveBy?: Date): Promise<{ minutes: number; estimated: boolean }> {
  if (!config.google.mapsKey) return { minutes: estimateTravelMin(from, to), estimated: true };
  try {
    const res = await fetch(ROUTES, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.google.mapsKey,
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: "TRANSIT",
        ...(arriveBy ? { arrivalTime: arriveBy.toISOString() } : {}),
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { routes?: { duration?: string }[] };
      const dur = data.routes?.[0]?.duration;
      if (dur) return { minutes: Math.round(parseInt(dur, 10) / 60), estimated: false };
    }
  } catch {
    // fall through to the estimate
  }
  return { minutes: estimateTravelMin(from, to), estimated: true };
}

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** "italian_restaurant" -> "italian"; generic types give null. */
export function cuisineFromTypes(primaryType?: string, types: string[] = []): string | null {
  for (const t of [primaryType, ...types]) {
    const m = t?.match(/^([a-z_]+)_restaurant$/);
    if (m && !["fast_food", "family"].includes(m[1])) return m[1].replace(/_/g, " ");
  }
  return null;
}

/** The decimal CID inside a googleMapsUri like https://maps.google.com/?cid=123. */
export function cidFromMapsUri(uri?: string): string | null {
  return uri?.match(/[?&]cid=(\d+)/)?.[1] ?? null;
}

/** Map a Places API result onto our place columns. */
export function toPlaceFields(g: GPlace): Partial<Place> {
  return {
    google_place_id: g.id,
    cid: cidFromMapsUri(g.googleMapsUri),
    name: g.displayName?.text,
    address: g.formattedAddress ?? null,
    lat: g.location?.latitude ?? null,
    lng: g.location?.longitude ?? null,
    primary_type: g.primaryType ?? null,
    types: g.types ?? [],
    cuisine: cuisineFromTypes(g.primaryType, g.types),
    price_level: g.priceLevel ? (PRICE_LEVELS[g.priceLevel] ?? null) : null,
    rating: g.rating ?? null,
    rating_count: g.userRatingCount ?? null,
    phone: g.nationalPhoneNumber ?? null,
    website: g.websiteUri ?? null,
    maps_url: g.googleMapsUri ?? null,
    opening_periods: g.regularOpeningHours?.periods ?? null,
    reservable: g.reservable ?? null,
    details_fetched_at: new Date().toISOString(),
  };
}

/** Review and summary text used to ground profiles and pitches. */
export function reviewSnippets(g: GPlace, max = 5): string[] {
  const out: string[] = [];
  if (g.editorialSummary?.text) out.push(`Google summary: ${g.editorialSummary.text}`);
  for (const r of (g.reviews ?? []).slice(0, max)) {
    const t = r.text?.text ?? r.originalText?.text;
    if (t) out.push(`Review (${r.rating ?? "?"}★): ${t.slice(0, 600)}`);
  }
  return out;
}
