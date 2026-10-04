import { z } from "zod";
import { extract } from "../llm";
import type { Prefs } from "../types";
import { now } from "../util/time";

export const ConstraintsSchema = z.object({
  date: z.string().nullable().describe("YYYY-MM-DD if the request names a day, else null"),
  time: z.string().nullable().describe("HH:mm 24h if the request names a time, else null"),
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
});

export type Constraints = z.infer<typeof ConstraintsSchema>;

export const EMPTY_CONSTRAINTS: Constraints = {
  date: null,
  time: null,
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
