import { config } from "../config";
import { getPlace, getPrefs, recentMessages, upcomingReservations } from "../db/repo";
import { db } from "../db";
import { anthropic, FALLBACK } from "../llm";
import type { Plan } from "../types";
import { fmtDate, now } from "../util/time";
import { tools } from "./tools";

const SYSTEM = `You are "Planner", the date-night agent in a WhatsApp group with Advait and Emily, a couple living in Tokyo (home near Gotanda/Fudomae, Advait works near Meguro station).

Your job: pick great places for their weekly date night, check availability, and handle reservations end to end (book, change, cancel), so they never have to.

How to work:
- Use the tools for anything involving places, availability or reservations. Never claim something is booked, available or cancelled unless a tool said so.
- For "plan/suggest/find somewhere" requests call recommend_options with their wording; it posts options and a poll itself.
- When someone answers an open proposal with a number or by naming/describing an option ("2", "the Italian one"), call pick_option for the sender. It books by itself once everyone needed has agreed. If they want something different ("none of these, closer to work"), call recommend_options again with that wording.
- Book directly (book_plan_option / book_place) only when someone explicitly says to book it. Cancel only when asked (or confirm with them first if it's ambiguous).
- Requests can be loose ("feeling italian, not too far from work", "somewhere like Monna Lisa", "Thursday instead"). Translate them into the right tool call rather than asking questions you can answer with a sensible default.
- Tools that post to the group (recommend_options, booking tools) already told them the result. Then keep your reply to one short line, or reply exactly NO_REPLY.
- Write like a friend in a chat: short, warm, no headings, at most one emoji. English unless they write in Japanese.
- Always answer a direct question or request (e.g. "tell me more about option 2" → call option_details and reply with 2–4 helpful sentences). Reply NO_REPLY only when a message plainly isn't for you.
- Only book places on a seat-only basis; never courses or anything needing a card. If asked about price, say the ¥ figures are average spend per person, not a course price.`;

function stateBlock(): string {
  const prefs = getPrefs();
  const res = upcomingReservations(now().toISODate()!)
    .map((r) => `#${r.id} ${getPlace(r.place_id)?.name} ${fmtDate(r.date)} ${r.time} ${r.party_size}p ${r.status} (${r.channel})`)
    .join("\n");
  const planRow = db().prepare("SELECT id FROM plans WHERE status = 'proposed' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  const plan = planRow ? (db().prepare("SELECT * FROM plans WHERE id = ?").get(planRow.id) as Record<string, string>) : null;
  const planText = plan
    ? `Open proposal for ${plan.date} ${plan.time}: ${(JSON.parse(plan.options) as Plan["options"]).map((o, i) => `${i + 1}. ${o.name}`).join(", ")}; votes ${plan.votes}`
    : "No open proposal.";
  const weekday = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `<state>
Now: ${now().toFormat("cccc yyyy-MM-dd HH:mm")} JST
Usual date night: ${weekday[prefs.defaultWeekday]} ${prefs.defaultTime}, ${prefs.partySize} people, max ${prefs.maxTravelMin} min travel, budget ¥${prefs.budgetPerPersonMaxJpy ?? "—"}/person${prefs.dietary ? `, dietary: ${prefs.dietary}` : ""}
Planning: options posted ${weekday[prefs.kickoff.weekday]} ${prefs.kickoff.time}, decided by ${weekday[prefs.decideBy.weekday]} ${prefs.decideBy.time}
Upcoming reservations:
${res || "none"}
${planText}
</state>`;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Handle one incoming group message. Runs are serialized so two quick
 * messages can't race each other into double bookings.
 */
export function handleMessage(sender: string, text: string): Promise<string | null> {
  const run = queue.then(() => runAgent(sender, text));
  queue = run.catch(() => undefined);
  return run;
}

async function runAgent(sender: string, text: string): Promise<string | null> {
  const chat = recentMessages(30)
    .map((m) => `[${m.at}] ${m.sender}: ${m.text}`)
    .join("\n");
  const runner = anthropic().beta.messages.toolRunner({
    model: config.anthropicModel,
    max_tokens: 16000,
    max_iterations: 12,
    output_config: { effort: "medium" },
    betas: FALLBACK.betas,
    fallbacks: FALLBACK.fallbacks,
    system: SYSTEM,
    tools,
    messages: [
      {
        role: "user",
        content: `${stateBlock()}\n\n<recent_chat>\n${chat}\n</recent_chat>\n\nNew message from ${sender}: ${text}`,
      },
    ],
  });
  const final = await runner;
  if (final.stop_reason === "refusal") return "Sorry, I can't help with that one.";
  const reply = final.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  return !reply || reply === "NO_REPLY" ? null : reply;
}
