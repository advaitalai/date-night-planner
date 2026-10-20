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

/** Words that say nothing about the cuisine ("japanese restaurant" = "japanese"). */
const GENERIC = new Set(["restaurant", "food", "cuisine", "style", "dining", "shop", "and", "&"]);

/**
 * Umbrella terms people ask for, and the cuisines they cover. Without these,
 * "latin american" matched "new american" and American barbecue on the shared
 * word (round 4), and never matched Cuban or Peruvian.
 */
const FAMILIES: Record<string, string[]> = {
  "latin american": ["mexican", "peruvian", "cuban", "brazilian", "argentinian", "argentine", "colombian", "venezuelan", "chilean", "caribbean", "latin", "tex-mex", "taco"],
  "south american": ["peruvian", "brazilian", "argentinian", "argentine", "colombian", "venezuelan", "chilean"],
  "middle eastern": ["lebanese", "turkish", "israeli", "persian", "iranian", "arab", "falafel", "kebab", "mediterranean"],
  "southeast asian": ["thai", "vietnamese", "indonesian", "malaysian", "singaporean", "filipino", "cambodian", "burmese"],
  "south asian": ["indian", "nepalese", "sri lankan", "pakistani", "bangladeshi", "curry"],
};

function meaningful(s: string): string[] {
  return [...words(s)].filter((w) => !GENERIC.has(w));
}

/**
 * How well a place's cuisine (a) fits an asked-for one (b): 1 = same, 0.5 = every
 * word asked for is there ("indian" fits "south indian"; "american" fits
 * "american barbecue"), or it's in the family asked for ("latin american" →
 * Cuban); else 0. One shared word isn't enough ("new american" ≠ "latin american").
 */
export function cuisineMatch(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const A = a.toLowerCase();
  const B = b.toLowerCase();
  if (A === B) return 1;
  const wa = new Set(meaningful(A));
  const wb = meaningful(B);
  if (wb.length && wb.every((w) => wa.has(w))) return 0.5;
  const family = FAMILIES[wb.join(" ")];
  if (family?.some((f) => A.includes(f))) return 0.5;
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
