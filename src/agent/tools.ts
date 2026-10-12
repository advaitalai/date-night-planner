import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { bookAndAnnounce, cancelReservation, checkAvailability, modifyReservation, policyLine } from "../booking/service";
import { config, PEOPLE, voters } from "../config";
import { db, kvSet } from "../db";
import { addVisit, findPlaceByName, getPlace, getPlan, getPrefs, upcomingReservations, updatePrefs, upsertPlace } from "../db/repo";
import { say, status } from "../notify";
import { callTime, clearPendingCall, pendingCall, runCall, scheduleCall } from "../booking/calls";
import { ensureWeeklyJobs, skipDate } from "../jobs/weekly";
import { cidFromMapsUri, placeDetails, reviewSnippets, textSearch, toPlaceFields } from "../places/google";
import { cidFromSavedUrl } from "../places/takeout";
import { bookOption, onVotes } from "../plans/decide";
import { proposePlan } from "../recommender";
import { onboardingLink } from "../web/server";
import { enrich, savedPool, toCandidate } from "../recommender/candidates";
import { cuisineOf, similarity } from "../recommender/similarity";
import type { Place, Plan } from "../types";
import type { Slot } from "../booking/types";
import { pickInWindow } from "../booking/window";
import { fmtDate, now } from "../util/time";

function latestProposedPlan(): Plan | undefined {
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

/** A phone call needs a human yes. The model may only pass true when the message itself asks for a call. */
const CALL_GO_AHEAD = z
  .boolean()
  .optional()
  .describe("True ONLY if the latest message explicitly tells you to phone/call (e.g. 'call Time Out to book'). Otherwise leave it out: if a call is needed, the bot asks first.");

function consensusReached(plan: Plan): boolean {
  return voters().every((p) => plan.votes[p]?.length === 1 && plan.votes[p][0] === plan.votes[voters()[0]]?.[0]);
}

const rawTools = [
  betaZodTool({
    name: "place_call",
    description:
      "Place the phone call the bot is waiting on (see 'Pending call' in <state>), after someone in the chat says yes to it: 'yes', 'call', 'go ahead', 'call now', 'call at 17:00', 'try again in 30 min', 'book 19:00 instead'. Never use it without that go-ahead in the latest message. A bare 'call', 'yes' or 'go ahead' means call NOW: leave at/in_minutes empty. Only schedule when they name a time ('at 17:00') or a delay ('in 30 min'), or say yes to a retry the bot itself suggested ('try again in 30 minutes?' → in_minutes 30).",
    inputSchema: z.object({
      at: z.string().optional().describe("HH:mm (JST) if they said to call at a time"),
      in_minutes: z.number().int().min(1).optional().describe("If they said to call in N minutes; use the suggested delay when they just say yes to it"),
      time: z.string().optional().describe("HH:mm to book instead of the original time, e.g. a time the restaurant offered"),
    }),
    run: async ({ at, in_minutes, time }) => {
      const call = pendingCall();
      if (!call) return "There's no call waiting for a go-ahead. If they asked to call a place, use book_place with call_go_ahead.";
      const next = { ...call, slot: time ? { ...call.slot, time } : call.slot, alternatives: undefined, suggestDelayMin: undefined };
      const when = callTime(at, in_minutes ?? (at ? undefined : call.suggestDelayMin));
      if (when) {
        await say(scheduleCall(next, when));
        return "Scheduled; the chat was told. Reply NO_REPLY.";
      }
      const out = await runCall(next);
      await say(out.message);
      return "Called; the outcome was posted to the chat. Reply NO_REPLY.";
    },
  }),

  betaZodTool({
    name: "decline_call",
    description: "They said no to the call the bot proposed (or want something else instead). Drops it.",
    inputSchema: z.object({}),
    run: async () => {
      clearPendingCall();
      return "Dropped the pending call. Acknowledge briefly and ask what they'd like instead, if unclear.";
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
      "Everything known about option N (1-based) of the latest proposal: cuisine, price, rating, highlights, dishes, review snippets, address, travel, booking terms. Use for 'tell me more about option 2' / 'why that one?'.",
    inputSchema: z.object({ option_number: z.number().int().min(1) }),
    run: async ({ option_number }) => {
      const row = db().prepare("SELECT id FROM plans ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
      const plan = row ? getPlan(row.id) : undefined;
      const opt = plan?.options[option_number - 1];
      if (!plan || !opt) return "No such option in the latest proposal.";
      const place = await enrich(getPlace(opt.placeId)!);
      let reviews: string[] = [];
      if (place.google_place_id && config.google.mapsKey) reviews = reviewSnippets(await placeDetails(place.google_place_id), 4);
      return [
        describe(place),
        `Pitch already sent: ${opt.pitch}`,
        place.profile ? `Profile: ${place.profile.summary} | vibe: ${place.profile.vibeTags.join(", ")} | dishes: ${place.profile.signatureDishes.join(", ")}` : "",
        place.address ? `Address: ${place.address}` : "",
        place.maps_url ? `Map: ${place.maps_url}` : "",
        `Booking: ${place.booking_channel}, ${opt.availability === "available" ? "table confirmed free" : "availability unconfirmed"} for ${plan.date} ${plan.time}`,
        ...reviews,
      ]
        .filter(Boolean)
        .join("\n");
    },
  }),

  betaZodTool({
    name: "pick_option",
    description:
      "Record that a person picked option N (1-based) of the open proposal, e.g. they replied '2', 'the Italian one' or 'armonia please'. Once everyone who needs to agree has picked it, books that place (and only that place) by booking site or email; if it needs a phone call it asks for a go-ahead first. Use the sender of the message as `person`.",
    inputSchema: z.object({ option_number: z.number().int().min(1), person: z.enum(PEOPLE) }),
    run: async ({ option_number, person }) => {
      const plan = latestProposedPlan();
      if (!plan) return "There is no open proposal right now.";
      if (option_number > plan.options.length) return `The proposal only has ${plan.options.length} options.`;
      await onVotes(plan.id, { ...plan.votes, [person]: [option_number - 1] });
      const after = getPlan(plan.id)!;
      if (after.status !== "proposed" || consensusReached(after)) return "Everyone agreed; the booking outcome (or a question about calling) was posted to the chat. Reply NO_REPLY.";
      const waiting = voters().filter((p) => !after.votes[p]?.length);
      return waiting.length ? `Noted ${person}'s pick (${plan.options[option_number - 1].name}). Waiting for ${waiting.join(" and ")}.` : "Picks recorded; they differ, the chat was told.";
    },
  }),

  betaZodTool({
    name: "book_plan_option",
    description: "Book option N (1-based) from the most recent proposed plan, e.g. when someone says 'book option 2' or 'let's do the second one'. Books only that place.",
    inputSchema: z.object({ option_number: z.number().int().min(1), call_go_ahead: CALL_GO_AHEAD }),
    run: async ({ option_number, call_go_ahead }) => {
      const plan = latestProposedPlan();
      if (!plan) return "There is no open proposal to book from.";
      if (option_number > plan.options.length) return `The plan only has ${plan.options.length} options.`;
      await bookOption(plan.id, option_number - 1, { callApproved: call_go_ahead });
      return "The outcome (or a question about calling) was posted to the chat. Reply NO_REPLY.";
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
      await bookAndAnnounce(place, slot, { notes, callApproved: call_go_ahead });
      return "The outcome (or a question about calling) was posted to the chat. Reply NO_REPLY.";
    },
  }),

  betaZodTool({
    name: "check_availability",
    description: "Check whether a restaurant has a table at a date/time (TableCheck/Tabelog places only; email-only places can't be checked in advance).",
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
    run: async ({ reservation_id, date, time, party_size, call_go_ahead }) => modifyReservation(reservation_id, { date, time, partySize: party_size }, { callApproved: call_go_ahead }),
  }),

  betaZodTool({
    name: "cancel_reservation",
    description: "Cancel a reservation. Only when someone in the group clearly asks to cancel it.",
    inputSchema: z.object({ reservation_id: z.number().int(), reason: z.string().optional(), call_go_ahead: CALL_GO_AHEAD }),
    run: async ({ reservation_id, reason, call_go_ahead }) => cancelReservation(reservation_id, reason, { callApproved: call_go_ahead }),
  }),

  betaZodTool({
    name: "confirm_still_on",
    description: "Record that the couple confirmed a reservation is still on (answers the 'still on?' check, prevents auto-cancel).",
    inputSchema: z.object({ reservation_id: z.number().int() }),
    run: async ({ reservation_id }) => {
      kvSet(`still_on:${reservation_id}`, true);
      return "Noted.";
    },
  }),

  betaZodTool({
    name: "update_preferences",
    description:
      "Change standing preferences: usual weekday (1=Mon..7=Sun) and time, kickoff/nudge/decide schedule, max travel minutes, budget per person (JPY), dietary notes, auto-cancel, cuisine cooldown.",
    inputSchema: z.object({
      defaultWeekday: z.number().int().min(1).max(7).optional(),
      defaultTime: z.string().optional(),
      partySize: z.number().int().optional(),
      kickoff: z.object({ weekday: z.number().int().min(1).max(7), time: z.string() }).optional(),
      nudge: z.object({ weekday: z.number().int().min(1).max(7), time: z.string() }).optional(),
      decideBy: z.object({ weekday: z.number().int().min(1).max(7), time: z.string() }).optional(),
      maxTravelMin: z.number().int().optional(),
      budgetPerPersonMaxJpy: z.number().int().nullable().optional(),
      dietary: z.string().optional(),
      autoCancel: z.boolean().optional(),
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
      ensureWeeklyJobs();
      return `Updated: ${Object.keys(clean).concat(homeAddress ? ["home"] : [], officeAddress ? ["office"] : []).join(", ")}.`;
    },
  }),

  betaZodTool({
    name: "skip_date",
    description: "No date night on this date (e.g. travelling); stops the weekly kickoff for it.",
    inputSchema: z.object({ date: z.string() }),
    run: async ({ date }) => {
      skipDate(date);
      return `Skipping ${date}.`;
    },
  }),

  betaZodTool({
    name: "add_saved_place",
    description: "Add a place to someone's saved list from a Google Maps link or a name.",
    inputSchema: z.object({ maps_url_or_name: z.string(), saved_by: z.enum(PEOPLE) }),
    run: async ({ maps_url_or_name, saved_by }) => {
      const isUrl = /^https?:\/\//.test(maps_url_or_name);
      const cid = isUrl ? (cidFromSavedUrl(maps_url_or_name) ?? cidFromMapsUri(maps_url_or_name)) : null;
      const name = isUrl ? decodeURIComponent(maps_url_or_name.match(/\/place\/([^/]+)/)?.[1] ?? "").replace(/\+/g, " ") : maps_url_or_name;
      if (!name && !cid) return "Couldn't read that link — paste the place name instead.";
      const place = upsertPlace({ name: name || "(from link)", cid, maps_url: isUrl ? maps_url_or_name : null, source: "chat", saved_by: [saved_by] });
      const e = await enrich(place);
      return `Added: ${describe(e)}`;
    },
  }),

  betaZodTool({
    name: "onboarding_links",
    description: "Links for each person to connect Google (Drive for saved-list exports; Gmail for the booker). Use for 'setup'.",
    inputSchema: z.object({}),
    run: async () => PEOPLE.map((p) => `${p}: ${onboardingLink(p)}`).join("\n"),
  }),
];

/** Short "what I'm doing" phrases for the live status line. */
const STATUS: Record<string, string> = {
  recommend_options: "Understanding what you're after…",
  option_details: "Pulling up details and reviews…",
  book_plan_option: "Booking it…",
  book_place: "Checking the table and booking…",
  check_availability: "Checking live availability…",
  search_places: "Searching places…",
  find_similar: "Finding similar places…",
  list_reservations: "Looking up your bookings…",
  modify_reservation: "Changing the booking…",
  cancel_reservation: "Cancelling the booking…",
  update_preferences: "Updating your preferences…",
  add_saved_place: "Adding the place…",
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
