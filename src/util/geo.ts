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
