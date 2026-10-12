import { z } from "zod";
import { extract } from "../llm";
import type { Prefs } from "../types";
import { now } from "../util/time";

export const FEATURES = ["live_music", "outdoor_seating", "cocktails", "wine", "vegetarian"] as const;

export const ConstraintsSchema = z.object({
  date: z.string().nullable().describe("YYYY-MM-DD if the request names a day, else null"),
  time: z.string().nullable().describe("HH:mm 24h if the request names a time, else null. For a range ('6 to 7:30 all good') the start."),
  latestTime: z
    .string()
    .nullable()
    .describe("HH:mm end of a range they're happy with ('6 to 7:30 all good' → 19:30); same as time for 'exactly 7, nothing else'; else null"),
  partySize: z.number().nullable(),
  cuisines: z.array(z.string()).describe("Cuisines wanted, lowercase, e.g. ['italian']; empty if open"),
  avoidCuisines: z.array(z.string()),
  anchor: z.enum(["home", "office", "other"]).describe("Where they travel from: 'office'/'work' → office"),
  anchorQuery: z.string().nullable().describe("Place/area name when anchor is 'other', e.g. 'Shibuya'"),
  maxTravelMin: z.number().nullable().describe("'not too far' ≈ 15, 'close' ≈ 10, 'don't mind travelling' ≈ 40"),
  budgetPerPersonMaxJpy: z.number().nullable(),
  vibe: z.array(z.string()).describe("Lowercase vibe words: 'romantic', 'live music', 'quiet', 'lively', 'counter', 'view'"),
  similarTo: z.string().nullable().describe("A restaurant they want something like"),
  onlySaved: z.boolean().describe("True only if they ask to stick to saved lists"),
  excludePlaces: z.array(z.string()).describe("Places they ruled out"),
  features: z
    .array(z.enum(FEATURES))
    .describe("Must-haves they asked for: live music, outdoor/terrace seating, cocktails, wine, vegetarian. Only when clearly asked for."),
  keepPrevious: z.boolean().describe("True only if they want earlier suggestions included again; asking for new/other/different options means false"),
});

export type Feature = (typeof FEATURES)[number];

export type Constraints = z.infer<typeof ConstraintsSchema>;

export const EMPTY_CONSTRAINTS: Constraints = {
  date: null,
  time: null,
  latestTime: null,
  partySize: null,
  cuisines: [],
  avoidCuisines: [],
  anchor: "home",
  anchorQuery: null,
  maxTravelMin: null,
  budgetPerPersonMaxJpy: null,
  vibe: [],
  similarTo: null,
  onlySaved: false,
  excludePlaces: [],
  features: [],
  keepPrevious: false,
};

/** Free text such as "feeling italian, not too far from work" → constraints. */
export async function parseRequest(text: string, prefs: Prefs): Promise<Constraints> {
  if (!text.trim()) return EMPTY_CONSTRAINTS;
  const today = now();
  return extract(
    ConstraintsSchema,
    `You turn date-night requests from a couple in Tokyo into search constraints.
Today is ${today.toFormat("cccc yyyy-MM-dd")} (JST). Their usual slot is weekday ${prefs.defaultWeekday} (1=Mon) at ${prefs.defaultTime}.
Home is near Gotanda/Fudomae; work is near Meguro station. Leave fields null/empty unless the request says something about them.`,
    text,
  );
}
