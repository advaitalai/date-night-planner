import { z } from "zod";
import { updatePlace } from "../db/repo";
import { extract } from "../llm";
import type { Place, PlaceProfile } from "../types";
import { placeDetails, reviewSnippets, toPlaceFields } from "./google";

const ProfileSchema = z.object({
  cuisine: z.string().describe("Single lowercase cuisine label, e.g. 'italian', 'south indian', 'yakitori', 'french bistro'"),
  vibeTags: z.array(z.string()).describe("Lowercase tags such as 'romantic', 'live music', 'counter seating', 'lively', 'quiet', 'terrace', 'casual', 'view'"),
  signatureDishes: z.array(z.string()).describe("Dishes the sources single out; empty if none are named"),
  highlights: z.array(z.string()).describe("Concrete facts worth pitching, each traceable to the sources"),
  priceBand: z.enum(["cheap", "mid", "upscale", "fine"]),
  summary: z.string().describe("One sentence"),
});

const SYSTEM = `You build short restaurant profiles for a date-night recommender in Tokyo.
Use only facts present in the provided sources. Never invent dishes, music, views or prices.
If the sources don't mention something, leave it out.`;

/** Fetch fresh details and build (or rebuild) the LLM profile for a place. */
export async function buildProfile(place: Place): Promise<Place> {
  if (!place.google_place_id) return place;
  const g = await placeDetails(place.google_place_id);
  const snippets = reviewSnippets(g, 5);
  const sources = [
    `Name: ${g.displayName?.text ?? place.name}`,
    `Google types: ${(g.types ?? []).join(", ")}`,
    g.priceLevel ? `Google price level: ${g.priceLevel}` : "",
    place.note ? `Saved-list note: ${place.note}` : "",
    ...snippets,
  ]
    .filter(Boolean)
    .join("\n");
  const profile: PlaceProfile = await extract(ProfileSchema, SYSTEM, sources);
  return updatePlace(place.id, { ...toPlaceFields(g), name: place.name, cuisine: profile.cuisine, profile });
}
