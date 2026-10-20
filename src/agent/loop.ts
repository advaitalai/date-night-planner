import { z } from "zod";
import { config } from "../config";
import { getPlace, getPrefs, recentMessages, upcomingReservations } from "../db/repo";
import { kvGet, kvSet } from "../db";
import { anthropic, extract, FALLBACK } from "../llm";
import { fmtDate, now } from "../util/time";
import { openProposal, tools } from "./tools";
import { describePendingCall } from "../booking/calls";
import { setCurrentMessage } from "./turn";

const SYSTEM = `You are "${config.wa.botName}", the date-night agent in a WhatsApp group with Advait and Emily, a couple living in Tokyo (home near Gotanda/Fudomae, Advait works near Meguro station).

Your job: pick great places for their weekly date night, check availability, and handle reservations end to end (book, change, cancel), so they never have to.

How to work:
- Use the tools for anything involving places, availability or reservations. Never claim something is booked, available or cancelled unless a tool said so.
- Never describe options beyond what the tool result says. If they asked for live music or Mexican and the result doesn't list it as met, don't say it was. Being honest about a miss beats sounding helpful.
- Never list suggested places in your own words. Every suggestion goes through recommend_options, which posts proper cards (what, why, area, travel, map link). If they ask "any live music places?", that's a recommend_options call.
- For "plan/suggest/find somewhere" requests call recommend_options with their full wish; it posts the options itself. When they add wishes ("but with live music"), pass the earlier ones that still apply too ("Thai or Mexican, with live music").
- Deciding: when either of them decides on one of the open options, call book_option. Either of them can decide alone, in any words: "2", "let's do the Thai one", "book Suan Sawan", or a yes to your "Shall I book X?". An opinion or a question is not a decision ("2 looks nice", "what about 1?"). If you're not sure, ask in one line: "Shall I book *X*?". If they want something different ("none of these, closer to work"), call recommend_options again with that wording. Never book a different place than the one they chose without asking.
- Phone calls: deciding on a phone-only place is the go-ahead, so book_option calls straight away (or says when they open). When the bot is waiting for a go-ahead (Pending call in <state>), read their answer like a person would: "ok call then", "go for it", "sure, try 19:00" → place_call (with the time if they gave one); "no", "don't", "leave it" → decline_call. If it's unclear, ask. For book_place, cancel_reservation and modify_reservation, pass call_go_ahead only when the message clearly says to go ahead and contact the restaurant ("cancel it, call them").
- If they say they already went somewhere, call log_visit.
- Time windows: by default the bot may take a table up to 30 min after the asked time without checking. If they give a range ("6 to 7:30 all good"), include it in the request / latest_time; "exactly 7" means no window.
- Book a place that isn't an open option (book_place) only when someone explicitly says to book it. Cancel only when asked (or confirm with them first if it's ambiguous).
- Requests can be loose ("feeling italian, not too far from work", "somewhere like Monna Lisa", "Thursday instead"). Translate them into the right tool call rather than asking questions you can answer with a sensible default.
- Tools that post to the group (recommend_options, booking and call tools) already told them the result. Then reply exactly NO_REPLY, unless they asked something the posted message doesn't answer.
- Write like a friend in a chat: short, warm, at most one emoji. Use WhatsApp formatting for anything longer than two lines: *bold* names, short lines, a blank line between items. Never use em dashes.
- If they ask for a cuisine or area and nothing fits, widen the search yourself (call recommend_options again with a bigger area or "any budget") before telling them there's nothing. Never just give up. English unless they write in Japanese.
- Every message you get was addressed to you (an inline reply to you, or it calls you by name). <recent_chat> also has what they said to each other; use it as context (e.g. what they were deciding between).
- Always answer a question or request (e.g. "tell me more about option 2" → call option_details and reply with 2–4 helpful sentences). Reply NO_REPLY only to things like "thanks" or "ok" that need no answer.
- If someone just says hi or asks what you can do, greet them back in one line, mention any open proposal or upcoming booking from <state>, and suggest 2–3 things to say (e.g. "plan Wednesday 18:30", "something Italian near work", "what's booked?"). Don't start planning unasked.
- Only book places on a seat-only basis; never courses or anything needing a card. If asked about price, say the ¥ figures are average spend per person, not a course price.`;

function stateBlock(): string {
  const prefs = getPrefs();
  const res = upcomingReservations(now().toISODate()!)
    .map((r) => `#${r.id} ${getPlace(r.place_id)?.name} ${fmtDate(r.date)} ${r.time} ${r.party_size}p ${r.status} (${r.channel})`)
    .join("\n");
  const plan = openProposal();
  const planText = plan ? `Open proposal for ${plan.date} ${plan.time}: ${plan.options.map((o, i) => `${i + 1}. ${o.name}`).join(", ")}` : "No open proposal.";
  const weekday = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `<state>
Now: ${now().toFormat("cccc yyyy-MM-dd HH:mm")} JST
Usual date night: ${weekday[prefs.defaultWeekday]} ${prefs.defaultTime}, ${prefs.partySize} people, max ${prefs.maxTravelMin} min travel, budget ¥${prefs.budgetPerPersonMaxJpy ?? "—"}/person${prefs.dietary ? `, dietary: ${prefs.dietary}` : ""}
Planning: options posted ${weekday[prefs.kickoff.weekday]} ${prefs.kickoff.time}, reminder ${weekday[prefs.nudge.weekday]} ${prefs.nudge.time} if nobody has picked
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
/** Longest a single message may take (a phone call can take ~8 min) before the chat is freed. */
const TURN_LIMIT_MS = 10 * 60_000;

export function handleMessage(sender: string, text: string, opts: { addressed?: boolean } = {}): Promise<string | null> {
  const addressed = opts.addressed ?? true;
  const run = queue.then(() =>
    Promise.race([
      addressed ? runAgent(sender, text) : listen(sender, text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("that took too long, so I stopped waiting")), TURN_LIMIT_MS)),
    ]),
  );
  queue = run.catch(() => undefined);
  return run;
}

async function runAgent(sender: string, text: string): Promise<string | null> {
  setCurrentMessage({ sender, text });
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
    // Tools + system prompt are the same on every message: cache them (1h, messages come minutes apart),
    // and let the top-level breakpoint cache the growing tool loop within a turn.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
    cache_control: { type: "ephemeral" },
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

const HeardSchema = z.object({
  decided_option: z.number().int().nullable().describe("The 1-based option number they've settled on, or null if they haven't clearly decided"),
});

const LISTEN_SYSTEM = `Advait and Emily are talking to each other in their group chat about date-night options a bot posted. Decide whether the conversation now shows they've settled on one option: either of them says they want it ("let's do 2", "book the Thai one", "Suan Sawan it is"), or one suggests it and the other agrees ("2?" "yes!"). An opinion or a question alone ("2 looks nice", "what do you think of 1?") is not a decision. If they're undecided, talking about something else, or want different options, answer null.`;

/**
 * A message between the two of them, not to the bot. The bot has no tools here
 * and can't book anything; it stays quiet unless they've just settled on one
 * of the open options, and then only asks them to confirm (once per option).
 */
async function listen(sender: string, text: string): Promise<string | null> {
  const plan = openProposal();
  if (!plan) return null;
  const chat = recentMessages(15)
    .map((m) => `${m.sender}: ${m.text}`)
    .join("\n");
  const options = plan.options.map((o, i) => `${i + 1}. ${o.name}`).join("\n");
  const { decided_option } = await extract(HeardSchema, LISTEN_SYSTEM, `Options:\n${options}\n\n<recent_chat>\n${chat}\n</recent_chat>\n\nLatest message, from ${sender}: ${text}`);
  const opt = decided_option ? plan.options[decided_option - 1] : undefined;
  if (!opt) return null;
  const key = `confirm_asked:${plan.id}:${decided_option}`;
  if (kvGet(key, false)) return null;
  kvSet(key, true);
  return `Sounds like *${opt.name}* 🙂 Shall I book it?\nReply to this message to confirm.`;
}
