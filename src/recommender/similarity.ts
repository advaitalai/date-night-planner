import type { Place } from "../types";

const BAND_LEVEL = { cheap: 1, mid: 2, upscale: 3, fine: 4 } as const;

export function priceLevelOf(p: Place): number | null {
  if (p.profile?.priceBand) return BAND_LEVEL[p.profile.priceBand];
  return p.price_level;
}

export function cuisineOf(p: Place): string | null {
  return (p.profile?.cuisine ?? p.cuisine)?.toLowerCase() ?? null;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[\s/,-]+/).filter(Boolean));
}

/** 1 = same cuisine, 0.5 = overlapping words ("south indian" vs "indian"), else 0. */
export function cuisineMatch(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w) && w !== "restaurant" && w !== "food") return 0.5;
  return 0;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a.map((x) => x.toLowerCase()));
  const B = new Set(b.map((x) => x.toLowerCase()));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 0..1 similarity on cuisine, vibe and price. */
export function similarity(a: Place, b: Place): number {
  const cuisine = cuisineMatch(cuisineOf(a), cuisineOf(b));
  const vibe = jaccard(a.profile?.vibeTags ?? [], b.profile?.vibeTags ?? []);
  const pa = priceLevelOf(a);
  const pb = priceLevelOf(b);
  const price = pa != null && pb != null ? 1 - Math.abs(pa - pb) / 3 : 0.5;
  return 0.45 * cuisine + 0.3 * vibe + 0.25 * price;
}

/** The saved place a candidate most resembles, for "similar to X on Emily's list". */
export function mostSimilarSaved(candidate: Place, saved: Place[]): { place: Place; sim: number } | null {
  let best: { place: Place; sim: number } | null = null;
  for (const s of saved) {
    if (s.id === candidate.id) continue;
    const sim = similarity(candidate, s);
    if (!best || sim > best.sim) best = { place: s, sim };
  }
  return best && best.sim >= 0.5 ? best : null;
}
