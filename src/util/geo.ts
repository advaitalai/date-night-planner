export interface LatLng {
  lat: number;
  lng: number;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Rough door-to-door minutes in central Tokyo when the Routes API has no
 * transit answer: walk up to ~1.2 km, otherwise train at ~20 km/h effective
 * plus 12 minutes of walking and waiting.
 */
export function estimateTravelMin(a: LatLng, b: LatLng): number {
  const km = haversineKm(a, b) * 1.3; // streets aren't straight lines
  if (km <= 1.2) return Math.round((km / 4.8) * 60);
  return Math.round((km / 20) * 60 + 12);
}

/** Close enough to walk: the card says "6 min walk" instead of a transit time. */
export const WALK_KM = 1.2;

export function walkMinutes(a: LatLng, b: LatLng): number | null {
  const km = haversineKm(a, b) * 1.3;
  return km <= WALK_KM ? Math.max(1, Math.round((km / 4.8) * 60)) : null;
}

/** "6 min walk", "22 min by train", "~25 min by train" (estimate when Google had no route). */
export function travelLabel(min: number, walk: boolean, estimated: boolean): string {
  if (walk) return `${min} min walk`;
  return `${estimated ? "~" : ""}${min} min by train`;
}

/**
 * The neighbourhood from a Google address, e.g.
 * "1 Chome-2-3 Ebisu, Shibuya City, Tokyo 150-0013, Japan" → "Ebisu".
 * Falls back to the ward ("Shibuya"), or null.
 */
export function areaOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim());
  const cityIdx = parts.findIndex((s) => /\b(City|Ward)$|-ku$/i.test(s));
  if (cityIdx >= 0) {
    const ward = parts[cityIdx].replace(/\s*(City|Ward)$|-ku$/i, "");
    const before = (parts[cityIdx - 1] ?? "")
      .replace(/\d+\s*Chome[-\d]*/gi, "")
      .replace(/[\d-]+/g, "")
      .trim();
    const area = before.split(/\s+/).filter((w) => /^[A-Z][a-zōū]+$/.test(w)).pop();
    return area && area.toLowerCase() !== ward.toLowerCase() ? area : ward;
  }
  const ja = address.match(/東京都(\S+?区)/);
  return ja ? ja[1] : null;
}
