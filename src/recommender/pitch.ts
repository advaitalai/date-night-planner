import { z } from "zod";
import { extract } from "../llm";
import type { Place } from "../types";
import type { Scored } from "./score";
import { mostSimilarSaved } from "./similarity";

export interface PitchInput {
  option: Scored;
  availability: "available" | "unconfirmed";
  anchorLabel: string;
}

/** Facts the pitch may use. Everything here comes from stored data. */
export function factsFor(input: PitchInput, saved: Place[]): Record<string, unknown> {
  const p = input.option.place;
  const similar = p.saved_by.length === 0 ? mostSimilarSaved(p, saved.filter((s) => s.saved_by.length > 0)) : null;
  return {
    name: p.name,
    cuisine: p.profile?.cuisine ?? p.cuisine,
    onLists: p.saved_by,
    similarToSaved: similar ? { name: similar.place.name, savedBy: similar.place.saved_by } : null,
    travel: `${input.option.travelMin} min from ${input.anchorLabel}${input.option.travelEstimated ? " (estimate)" : ""}`,
    googleRating: p.rating,
    tabelogScore: p.tabelog_score,
    signatureDishes: p.profile?.signatureDishes ?? [],
    highlights: p.profile?.highlights ?? [],
    vibe: p.profile?.vibeTags ?? [],
    priceBand: p.profile?.priceBand ?? null,
    whyRanked: input.option.reasons,
    availability: input.availability === "available" ? "table confirmed free at that time" : "email-only: availability not confirmed yet",
  };
}

const PitchSchema = z.object({ pitches: z.array(z.string()) });

/**
 * One or two warm, specific sentences per option, written only from the
 * provided facts (no invented dishes or features).
 */
export async function writePitches(inputs: PitchInput[], saved: Place[]): Promise<string[]> {
  const facts = inputs.map((i) => factsFor(i, saved));
  try {
    const out = await extract(
      PitchSchema,
      `You write short date-night pitches for a couple's WhatsApp group (Advait and Emily).
For each option write 1–2 sentences: what's good about it (dish, vibe), why it fits this week, travel time.
If similarToSaved is set, say it's similar to that place on that person's list.
Use ONLY the given facts. If a fact is missing, don't mention it. No emojis except at most one per pitch. Return one pitch per option in order.`,
      JSON.stringify(facts, null, 2),
      "medium",
    );
    if (out.pitches.length === inputs.length) return out.pitches;
  } catch (err) {
    console.warn("pitch writing failed:", (err as Error).message);
  }
  // Plain fallback built from the same facts.
  return facts.map((f) => [f.cuisine, f.travel, ...(f.whyRanked as string[])].filter(Boolean).join(" · "));
}
