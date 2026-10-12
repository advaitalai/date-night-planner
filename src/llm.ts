import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "./config";

let client: Anthropic | undefined;

/**
 * PLANNER_ANTHROPIC_API_KEY is an alternative name for the key: Claude Code's
 * cloud sandbox reserves ANTHROPIC_* variables for its own login, so a key
 * stored there under ANTHROPIC_API_KEY never reaches the app.
 */
export function anthropic(): Anthropic {
  const apiKey = process.env.PLANNER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  client ??= apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  return client;
}

/** Refusal fallback: let the API route a declined request to a fallback model. */
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

/**
 * One structured-output call: returns the parsed object or throws. Used for
 * request parsing, place profiles, policy and email extraction.
 */
export async function extract<S extends z.ZodType>(
  schema: S,
  system: string,
  user: string,
  effort: "low" | "medium" | "high" = "low",
): Promise<z.infer<S>> {
  const res = await anthropic().messages.parse({
    model: config.anthropicModel,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: zodOutputFormat(schema) },
  });
  if (res.stop_reason === "refusal") throw new Error("model declined the request");
  if (res.parsed_output == null) throw new Error(`structured output did not parse (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}

/** Plain text completion for short writing tasks (pitches, emails). */
export async function write(system: string, user: string, effort: "low" | "medium" | "high" = "medium"): Promise<string> {
  const res = await anthropic().messages.create({
    model: config.anthropicModel,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort },
  });
  if (res.stop_reason === "refusal") throw new Error("model declined the request");
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
