import type { Place } from "../types";
import type { Candidate } from "./filters";
import type { Constraints } from "./parseRequest";
import { cuisineMatch, cuisineOf, similarity } from "./similarity";

export interface ScoreContext {
  constraints: Constraints;
  /** Cuisines of the most recent dates, newest first. */
  recentCuisines: string[];
  cuisineCooldownDates: number;
  /** Resolved place for constraints.similarTo, if any. */
  similarTo: Place | null;
}

export interface Scored extends Candidate {
  score: number;
  reasons: string[];
}

export function scoreCandidate(c: Candidate, ctx: ScoreContext): Scored {
  const p = c.place;
  const reasons: string[] = [];
  let score = 0;

  if (p.rating != null) score += Math.max(-2, Math.min(2.5, (p.rating - 3.8) * 2.5));
  if (p.tabelog_score != null) score += Math.max(-1, Math.min(3, (p.tabelog_score - 3.3) * 6));

  if (p.saved_by.length >= 2) {
    score += 2;
    reasons.push("on both your lists");
  } else if (p.saved_by.length === 1) {
    score += 1;
    reasons.push(`on ${p.saved_by[0]}'s list`);
  }

  // Cuisine rotation: a cuisine from the last few dates is pushed down, most recent hardest.
  const cuisine = cuisineOf(p);
  const recent = ctx.recentCuisines.slice(0, ctx.cuisineCooldownDates);
  const hit = recent.findIndex((rc) => cuisineMatch(cuisine, rc) > 0);
  if (hit >= 0) score -= 3 - hit * (2 / Math.max(1, ctx.cuisineCooldownDates));
  else if (cuisine) reasons.push(`a change from recent ${recent.length ? recent.join("/") : "dates"}`);

  const k = ctx.constraints;
  if (k.cuisines.some((w) => cuisineMatch(cuisine, w) > 0)) score += 2;
  const vibes = new Set((p.profile?.vibeTags ?? []).map((v) => v.toLowerCase()));
  for (const v of k.vibe) {
    if (vibes.has(v.toLowerCase())) {
      score += 1;
      reasons.push(v);
    }
  }

  if (ctx.similarTo) {
    const sim = similarity(p, ctx.similarTo);
    score += 4 * sim;
    if (sim >= 0.5) reasons.push(`similar to ${ctx.similarTo.name}`);
  }

  score -= 0.06 * c.travelMin;
  if (c.lastVisitDaysAgo == null) score += 0.5;

  return { ...c, score: Math.round(score * 100) / 100, reasons };
}

/**
 * Pick `n` options: best score first, at most one per cuisine, and make room
 * for one discovered (not-yet-saved) place when it's competitive.
 */
export function pickDiverse(scored: Scored[], n = 3): Scored[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked: Scored[] = [];
  const cuisines = new Set<string>();
  for (const s of sorted) {
    const c = cuisineOf(s.place) ?? `#${s.place.id}`;
    if (cuisines.has(c)) continue;
    picked.push(s);
    cuisines.add(c);
    if (picked.length === n) break;
  }
  for (const s of sorted) {
    if (picked.length < n && !picked.includes(s)) picked.push(s);
  }

  const hasDiscovered = picked.some((s) => s.place.saved_by.length === 0);
  if (!hasDiscovered && picked.length === n) {
    const last = picked[n - 1];
    const fresh = sorted.find(
      (s) => s.place.saved_by.length === 0 && !picked.includes(s) && !picked.slice(0, n - 1).some((p) => cuisineOf(p.place) === cuisineOf(s.place)) && last.score - s.score <= 1.5,
    );
    if (fresh) picked[n - 1] = fresh;
  }
  return picked;
}
