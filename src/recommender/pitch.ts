import { z } from "zod";
import { extract } from "../llm";
import type { Place } from "../types";
import type { Scored } from "./score";
import { mostSimilarSaved } from "./similarity";

export interface PitchInput {
  option: Scored;
  availability: "available" | "unconfirmed" | "unchecked";
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
    bookingNote: input.availability === "available" ? "table confirmed free at that time" : "availability is checked when booking",
  };
}

export interface Pitch {
  /** What the place is, in one short line: food + feel. */
  what: string;
  /** Why it was picked this week, in one short line. */
  why: string;
}

const PitchSchema = z.object({ pitches: z.array(z.object({ what: z.string(), why: z.string() })) });

/**
 * A short "what" and "why" per option, written only from the provided facts
 * (no invented dishes or features). Kept to one line each so the options
 * message stays scannable on a phone.
 */
export async function writePitches(inputs: PitchInput[], saved: Place[]): Promise<Pitch[]> {
  const facts = inputs.map((i) => factsFor(i, saved));
  try {
    const out = await extract(
      PitchSchema,
      `You write date-night options for a couple's WhatsApp chat (Advait and Emily).
For each option return:
- what: one short line (max ~12 words) on the food and the feel, e.g. "Handmade pasta and charcoal-grilled wagyu in a cosy counter bar".
- why: one short line (max ~14 words) on why it fits this week: their lists, a change of cuisine, similar to a place they saved, closeness.
Use ONLY the given facts. If a fact is missing, leave it out. No emojis, no em dashes. One entry per option, in order.`,
      JSON.stringify(facts, null, 2),
      "medium",
    );
    if (out.pitches.length === inputs.length) return out.pitches;
  } catch (err) {
    console.warn("pitch writing failed:", (err as Error).message);
  }
  return facts.map(fallbackPitch);
}

/** Built from the same facts when the model isn't available. */
export function fallbackPitch(f: Record<string, unknown>): Pitch {
  const highlights = (f.highlights as string[]).slice(0, 1);
  const what = [f.cuisine ? String(f.cuisine).replace(/^\w/, (c) => c.toUpperCase()) : "Restaurant", ...highlights].join(" · ");
  const similar = f.similarToSaved as { name: string; savedBy: string[] } | null;
  const why = [...(f.whyRanked as string[]), similar ? `similar to ${similar.name} (${similar.savedBy.join(" & ")}'s list)` : null].filter(Boolean).join(", ");
  return { what, why: why || "free table at your usual time" };
}
