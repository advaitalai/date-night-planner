import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { bookAndAnnounce, cancelReservation, checkAvailability, ensureDetected, howBooked, modifyReservation, policyLine } from "../booking/service";
import { config } from "../config";
import { db } from "../db";
import { addVisit, findPlaceByName, getPlace, getPlan, getPrefs, getReservation, upcomingReservations, updatePrefs, updateReservation, upsertPlace } from "../db/repo";
import { cancelJobs } from "../jobs/scheduler";
import { say, status } from "../notify";
import { clearPendingCall, pendingCall, runCall } from "../booking/calls";
import { placeDetails, reviewSnippets, textSearch, toPlaceFields } from "../places/google";
import { bookOption } from "../plans/decide";
import { proposePlan } from "../recommender";
import { enrich, savedPool, toCandidate } from "../recommender/candidates";
import { cuisineOf, similarity } from "../recommender/similarity";
import type { Place, Plan } from "../types";
import type { Slot } from "../booking/types";
import { pickInWindow } from "../booking/window";
import { fmtDate, now } from "../util/time";

/** The options waiting for a decision, if any. */
export function openProposal(): Plan | undefined {
  const row = db().prepare("SELECT id FROM plans WHERE status = 'proposed' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  return row ? getPlan(row.id) : undefined;
}

async function placeByName(name: string): Promise<Place | null> {
  const local = findPlaceByName(name);
  if (local) return enrich(local);
  if (!config.google.mapsKey) return null;
  const [g] = await textSearch(`${name} Tokyo`, getPrefs().anchors.home, 20000, 1);
  if (!g) return null;
  return enrich(upsertPlace({ ...toPlaceFields(g), name: g.displayName?.text ?? name, source: "discovered" }));
}

function describe(p: Place): string {
  return [
    p.name,
    cuisineOf(p),
    p.rating != null ? `Google ${p.rating}` : null,
    p.tabelog_score != null ? `Tabelog ${p.tabelog_score}` : null,
    `booking: ${p.booking_channel}`,
    p.saved_by.length ? `saved by ${p.saved_by.join(" & ")}` : "not on your lists",
    p.profile?.highlights.length ? `highlights: ${p.profile.highlights.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

const slotFields = {
  date: z.string().describe("YYYY-MM-DD (JST)"),
  time: z.string().describe("HH:mm 24h (JST)"),
  party_size: z.number().int().min(1).max(12).optional(),
};

/**
 * Post a tool's outcome to the chat itself. The agent replies NO_REPLY after tools
 * that post, so a result it was meant to relay (e.g. "Shall I call to cancel?")
 * could end up never shown.
 */
async function posted(message: string): Promise<string> {
  await say(message);
  return `Posted to the chat: ${message.slice(0, 300)}\nReply NO_REPLY.`;
}

const goAhead = (flag: boolean | undefined) => Boolean(flag);

const CALL_GO_AHEAD = z
  .boolean()
  .optional()
  .describe("True only if the latest message clearly says to go ahead and contact the restaurant (e.g. 'cancel it, call them', 'ring them and move it to 8'). Otherwise leave it out: if a call is needed, the bot asks first.");

const rawTools = [
  betaZodTool({
    name: "place_call",
    description:
      "Place the phone call the bot is waiting on (see 'Pending call' in <state>) when they say go ahead, in any words: 'call', 'ok call then', 'go for it', 'sure', 'try 19:00'. Calls right away (there are no calls for later; if they want a later time, tell them to reply when they're ready). If you're unsure they mean yes, ask instead.",
    inputSchema: z.object({
      time: z.string().optional().describe("HH:mm to book instead of the original time, e.g. a time the restaurant offered"),
    }),
    run: async ({ time }) => {
      const call = pendingCall();
      if (!call) return "There's no call waiting for a go-ahead. If they asked to call a place, use book_place, cancel_reservation or modify_reservation with call_go_ahead.";
      const out = await runCall({ ...call, slot: time ? { ...call.slot, time } : call.slot, alternatives: undefined });
      await say(out.message);
      return "Called; the outcome was posted to the chat. Reply NO_REPLY.";
    },
  }),

  betaZodTool({
    name: "decline_call",
    description: "They said no to the call the bot asked about ('no', 'don't call', 'leave it'). Drops it. Only tell them it's dropped using this tool's result.",
    inputSchema: z.object({}),
    run: async () => {
      const had = Boolean(pendingCall());
      clearPendingCall();
      return had ? "Dropped. No call will be made." : "There was no call waiting.";
    },
  }),

  betaZodTool({
    name: "log_visit",
    description: "Record that they already went to a place (e.g. 'we went to h:armonia last week'), so it isn't suggested again soon.",
    inputSchema: z.object({ place_name: z.string(), date: z.string().optional().describe("YYYY-MM-DD if known, else today") }),
    run: async ({ place_name, date }) => {
      const place = await placeByName(place_name);
      if (!place) return `Couldn't find "${place_name}".`;
      addVisit(place.id, date ?? now().toISODate()!, cuisineOf(place));
      return `Logged a visit to ${place.name}. It won't be suggested again for a while.`;
    },
  }),

  betaZodTool({
    name: "recommend_options",
    description:
      "Find and post up to 3 date-night options with pitches to the chat. Use for any 'plan / suggest / find us somewhere' request, including 'new options' or added wishes. Pass the person's full wish as `request`, combining earlier wishes that still apply (cuisine, area, 'near work', must-haves like live music or a terrace, 'similar to X', 'not X'). Places already suggested for that date are left out unless they ask for them again.",
    inputSchema: z.object({
      request: z.string().describe("The request in their words; empty string for a default proposal"),
      date: z.string().optional().describe("YYYY-MM-DD if known; defaults to the next usual date night"),
    }),
    run: async ({ request, date }) => {
      const { facts } = await proposePlan(request, { date });
      return `${facts}\nAlready posted to the chat. Reply exactly NO_REPLY. If you must add something, only state what these facts say; never claim a wish was met unless it's listed.`;
    },
  }),

  betaZodTool({
    name: "option_details",
    description:
      "Everything known about option N (1-based) of the latest proposal: cuisine, price, rating, highlights, dishes, review snippets, address, travel, and how it would be booked (TableCheck or phone). Use for 'tell me more about option 2' / 'why that one?'.",
    inputSchema: z.object({ option_number: z.number().int().min(1) }),
    run: async ({ option_number }) => {
      const row = db().prepare("SELECT id FROM plans ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
      const plan = row ? getPlan(row.id) : undefined;
      const opt = plan?.options[option_number - 1];
      if (!plan || !opt) return "No such option in the latest proposal.";
      const place = await ensureDetected(await enrich(getPlace(opt.placeId)!));
      let reviews: string[] = [];
      if (place.google_place_id && config.google.mapsKey) reviews = reviewSnippets(await placeDetails(place.google_place_id), 4);
      return [
        describe(place),
        `Pitch already sent: ${opt.pitch}`,
        place.profile ? `Profile: ${place.profile.summary} | vibe: ${place.profile.vibeTags.join(", ")} | dishes: ${place.profile.signatureDishes.join(", ")}` : "",
        place.address ? `Address: ${place.address}` : "",
        place.maps_url ? `Map: ${place.maps_url}` : "",
        `How I'd book it: ${howBooked(place)}. Availability for ${plan.date} ${plan.time} is checked when booking.`,
        ...reviews,
      ]
        .filter(Boolean)
        .join("\n");
    },
  }),

  betaZodTool({
    name: "book_option",
    description:
      "Book option N (1-based) of the open proposal once either of them has decided on it ('2', 'let's do the Thai one', a yes to 'Shall I book X?'). Books only that place: TableCheck if it has it, else it phones them straight away (deciding is the go-ahead; if they're closed it says when they open and waits).",
    inputSchema: z.object({ option_number: z.number().int().min(1) }),
    run: async ({ option_number }) => {
      const plan = openProposal();
      if (!plan) return "There is no open proposal to book from.";
      if (option_number > plan.options.length) return `The proposal only has ${plan.options.length} options.`;
      await bookOption(plan.id, option_number - 1);
      return "The outcome (or a question) was posted to the chat. Reply NO_REPLY.";
    },
  }),

  betaZodTool({
    name: "book_place",
    description: "Book a specific named restaurant for a date/time (only when someone explicitly asks to book it). Checks availability first. Books only that place.",
    inputSchema: z.object({
      place_name: z.string(),
      ...slotFields,
      latest_time: z.string().optional().describe("HH:mm end of the range they're happy with ('7 to 8 is fine' → 20:00); leave out to use the default window"),
      notes: z.string().optional(),
      call_go_ahead: CALL_GO_AHEAD,
    }),
    run: async ({ place_name, date, time, party_size, latest_time, notes, call_go_ahead }) => {
      const place = await placeByName(place_name);
      if (!place) return `Couldn't find "${place_name}".`;
      let slot: Slot = { date, time, partySize: party_size ?? getPrefs().partySize, ...(latest_time ? { latest: latest_time } : {}) };
      const avail = await checkAvailability(place, slot);
      const inWin = avail.status === "unavailable" ? pickInWindow(avail.alternatives, slot) : null;
      if (inWin) slot = { ...slot, time: inWin, asked: time };
      else if (avail.status === "unavailable") return `${place.name} is full at ${time} on ${date}. Free nearby: ${avail.alternatives?.join(", ") || "none"}.`;
      await bookAndAnnounce(place, slot, { notes, callApproved: goAhead(call_go_ahead) });
      return "The outcome (or a question about calling) was posted to the chat. Reply NO_REPLY.";
    },
  }),

  betaZodTool({
    name: "check_availability",
    description: "Check whether a restaurant has a table at a date/time (TableCheck places only; phone-only places are checked on the call).",
    inputSchema: z.object({ place_name: z.string(), ...slotFields }),
    run: async ({ place_name, date, time, party_size }) => {
      const place = await placeByName(place_name);
      if (!place) return `Couldn't find "${place_name}".`;
      const r = await checkAvailability(place, { date, time, partySize: party_size ?? getPrefs().partySize });
      return `${place.name} (${place.booking_channel}): ${r.status}${r.alternatives?.length ? `; free nearby: ${r.alternatives.join(", ")}` : ""}${r.detail ? ` (${r.detail})` : ""}`;
    },
  }),

  betaZodTool({
    name: "search_places",
    description:
      "Look up facts about a restaurant someone named, to answer a question ('is Blue Note near home?', 'what's Kuss like?'). Doesn't post anything. NOT for suggesting places: suggestions always go through recommend_options so they get proper cards.",
    inputSchema: z.object({ query: z.string(), from: z.enum(["home", "office"]).optional() }),
    run: async ({ query, from }) => {
      const anchor = getPrefs().anchors[from ?? "home"];
      const saved = savedPool().filter((p) => p.name.toLowerCase().includes(query.toLowerCase()) || cuisineOf(p)?.includes(query.toLowerCase()));
      const found: Place[] = [...saved.slice(0, 5)];
      if (config.google.mapsKey) {
        for (const g of await textSearch(query, anchor, 3000, 5)) found.push(upsertPlace({ ...toPlaceFields(g), name: g.displayName?.text ?? "?", source: "discovered" }));
      }
      const slot = { date: now().toISODate()!, time: getPrefs().defaultTime, partySize: 2 };
      const lines = await Promise.all(
        found.slice(0, 8).map(async (p) => {
          const e = await enrich(p);
          const c = await toCandidate(e, anchor, slot);
          return `${describe(e)}${c ? ` | ${c.travelMin} min from ${anchor.label}` : ""}`;
        }),
      );
      return lines.join("\n") || "Nothing found.";
    },
  }),

  betaZodTool({
    name: "find_similar",
    description: "Find places similar (cuisine, vibe, price) to a named restaurant, from the saved lists and beyond.",
    inputSchema: z.object({ place_name: z.string() }),
    run: async ({ place_name }) => {
      const target = await placeByName(place_name);
      if (!target) return `Couldn't find "${place_name}".`;
      const ranked = savedPool()
        .filter((p) => p.id !== target.id)
        .map((p) => ({ p, s: similarity(p, target) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      return ranked.map(({ p, s }) => `${describe(p)} | similarity ${s.toFixed(2)}`).join("\n");
    },
  }),

  betaZodTool({
    name: "list_reservations",
    description: "Upcoming reservations with ids, status and cancellation deadlines.",
    inputSchema: z.object({}),
    run: async () => {
      const rs = upcomingReservations(now().toISODate()!);
      if (!rs.length) return "No upcoming reservations.";
      return rs
        .map((r) => `#${r.id} ${getPlace(r.place_id)!.name} — ${fmtDate(r.date)} ${r.time}, ${r.party_size}p, ${r.status} via ${r.channel}${r.external_ref ? `, ref ${r.external_ref}` : ""}. ${policyLine(r)}`)
        .join("\n");
    },
  }),

  betaZodTool({
    name: "modify_reservation",
    description: "Change time, date or party size of an existing reservation.",
    inputSchema: z.object({
      reservation_id: z.number().int(),
      date: z.string().optional(),
      time: z.string().optional(),
      party_size: z.number().int().optional(),
      call_go_ahead: CALL_GO_AHEAD,
    }),
    run: async ({ reservation_id, date, time, party_size, call_go_ahead }) =>
      posted(await modifyReservation(reservation_id, { date, time, partySize: party_size }, { callApproved: goAhead(call_go_ahead) })),
  }),

  betaZodTool({
    name: "cancel_reservation",
    description:
      "Cancel a reservation. Only when someone in the group clearly asks to cancel it. If they say they already cancelled it themselves (called the restaurant, used the TableCheck link), set already_cancelled: it's then only marked cancelled, nothing is contacted.",
    inputSchema: z.object({
      reservation_id: z.number().int(),
      reason: z.string().optional(),
      already_cancelled: z.boolean().optional().describe("True when they cancelled it themselves outside the bot"),
      call_go_ahead: CALL_GO_AHEAD,
    }),
    run: async ({ reservation_id, reason, already_cancelled, call_go_ahead }) => {
      if (already_cancelled) {
        const r = getReservation(reservation_id);
        if (!r || (r.status !== "confirmed" && r.status !== "requested")) return `No active reservation #${reservation_id}.`;
        updateReservation(r.id, { status: "cancelled", notes: [r.notes, `cancelled by them directly${reason ? `: ${reason}` : ""}`].filter(Boolean).join(" / ") });
        cancelJobs(`res:${r.id}:`);
        return `Marked #${r.id} ${getPlace(r.place_id)?.name} (${r.date} ${r.time}) as cancelled. Nothing was contacted; reminders for it are off.`;
      }
      return posted(await cancelReservation(reservation_id, reason, { callApproved: goAhead(call_go_ahead) }));
    },
  }),

  betaZodTool({
    name: "update_preferences",
    description:
      "Change standing preferences: usual weekday (1=Mon..7=Sun) and time, max travel minutes, budget per person (JPY), dietary notes, cuisine cooldown.",
    inputSchema: z.object({
      defaultWeekday: z.number().int().min(1).max(7).optional(),
      defaultTime: z.string().optional(),
      partySize: z.number().int().optional(),
      maxTravelMin: z.number().int().optional(),
      budgetPerPersonMaxJpy: z.number().int().nullable().optional(),
      dietary: z.string().optional(),
      flexLaterMin: z.number().int().min(0).max(120).optional().describe("Minutes after the asked time the bot may accept without asking (default 30)"),
      cuisineCooldownDates: z.number().int().optional(),
      homeAddress: z.string().optional(),
      officeAddress: z.string().optional(),
    }),
    run: async ({ homeAddress, officeAddress, ...patch }) => {
      const prefs = getPrefs();
      const anchors = { ...prefs.anchors };
      for (const [key, address] of [
        ["home", homeAddress],
        ["office", officeAddress],
      ] as const) {
        if (!address) continue;
        const [g] = config.google.mapsKey ? await textSearch(address, anchors[key], 30000, 1) : [];
        if (!g?.location) return `Couldn't locate "${address}".`;
        anchors[key] = { ...anchors[key], address, lat: g.location.latitude, lng: g.location.longitude };
      }
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      updatePrefs({ ...clean, anchors });
      return `Updated: ${Object.keys(clean).concat(homeAddress ? ["home"] : [], officeAddress ? ["office"] : []).join(", ")}.`;
    },
  }),

];

/** Short "what I'm doing" phrases for the live status line. */
const STATUS: Record<string, string> = {
  recommend_options: "Understanding what you're after…",
  option_details: "Pulling up details and reviews…",
  book_option: "Booking it…",
  book_place: "Checking the table and booking…",
  check_availability: "Checking live availability…",
  search_places: "Searching places…",
  find_similar: "Finding similar places…",
  list_reservations: "Looking up your bookings…",
  modify_reservation: "Changing the booking…",
  cancel_reservation: "Cancelling the booking…",
  update_preferences: "Updating your preferences…",
  place_call: "Getting ready to call…",
  log_visit: "Noting the visit…",
};

export const tools = rawTools.map((t) => ({
  ...t,
  run: async (...args: Parameters<typeof t.run>) => {
    if (STATUS[t.name]) await status(STATUS[t.name]);
    return (t.run as (...a: unknown[]) => ReturnType<typeof t.run>)(...args);
  },
}));
