import { config } from "../config";
import { getPlace, getPrefs, recentMessages, upcomingReservations } from "../db/repo";
import { db } from "../db";
import { anthropic, FALLBACK } from "../llm";
import type { Plan } from "../types";
import { fmtDate, now } from "../util/time";
import { tools } from "./tools";
import { describePendingCall } from "../booking/calls";

const SYSTEM = `You are "Planner", the date-night agent in a WhatsApp group with Advait and Emily, a couple living in Tokyo (home near Gotanda/Fudomae, Advait works near Meguro station).

Your job: pick great places for their weekly date night, check availability, and handle reservations end to end (book, change, cancel), so they never have to.

How to work:
- Use the tools for anything involving places, availability or reservations. Never claim something is booked, available or cancelled unless a tool said so.
- Never describe options beyond what the tool result says. If they asked for live music or Mexican and the result doesn't list it as met, don't say it was. Being honest about a miss beats sounding helpful.
- For "plan/suggest/find somewhere" requests call recommend_options with their full wish; it posts the options itself. When they add wishes ("but with live music"), pass the earlier ones that still apply too ("Thai or Mexican, with live music").
- Phone calls are only ever made with a human go-ahead. When the bot has asked "Shall I call…?" (see Pending call in <state>), a yes → place_call; a no → decline_call. Pass call_go_ahead only when the message itself says to call. Never book a different place than the one they chose without asking.
- If they say they already went somewhere, call log_visit.
- Options are answered by replying with a number or a description${config.wa.polls ? " or in the poll" : ""}. ${config.wa.polls ? "" : "There is no poll; never mention one. "}When someone answers an open proposal with a number or by naming/describing an option ("2", "the Italian one"), call pick_option for the sender. It books by itself once everyone needed has agreed. If they want something different ("none of these, closer to work"), call recommend_options again with that wording.
- Book directly (book_plan_option / book_place) only when someone explicitly says to book it. Cancel only when asked (or confirm with them first if it's ambiguous).
- Requests can be loose ("feeling italian, not too far from work", "somewhere like Monna Lisa", "Thursday instead"). Translate them into the right tool call rather than asking questions you can answer with a sensible default.
- Tools that post to the group (recommend_options, booking and call tools) already told them the result. Then reply exactly NO_REPLY, unless they asked something the posted message doesn't answer.
- Write like a friend in a chat: short, warm, at most one emoji. Use WhatsApp formatting for anything longer than two lines: *bold* names, short lines, a blank line between items. Never use em dashes.
- If they ask for a cuisine or area and nothing fits, widen the search yourself (call recommend_options again with a bigger area or "any budget") before telling them there's nothing. Never just give up. English unless they write in Japanese.
- Always answer a direct question or request (e.g. "tell me more about option 2" → call option_details and reply with 2–4 helpful sentences). Reply NO_REPLY only when a message plainly isn't for you.
- If someone just says hi or asks what you can do, greet them back in one line, mention any open proposal or upcoming booking from <state>, and suggest 2–3 things to say (e.g. "plan Wednesday 18:30", "something Italian near work", "what's booked?"). Don't start planning unasked.
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
Pending call: ${describePendingCall() ?? "none"}
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
