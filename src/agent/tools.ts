import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { bookAndAnnounce, cancelReservation, checkAvailability, modifyReservation, policyLine } from "../booking/service";
import { config, PEOPLE } from "../config";
import { db, kvSet } from "../db";
import { findPlaceByName, getPlace, getPlan, getPrefs, upcomingReservations, updatePrefs, upsertPlace } from "../db/repo";
import { ensureWeeklyJobs, skipDate } from "../jobs/weekly";
import { cidFromMapsUri, textSearch, toPlaceFields } from "../places/google";
import { cidFromSavedUrl } from "../places/takeout";
import { bookOption } from "../plans/decide";
import { proposePlan } from "../recommender";
import { onboardingLink } from "../web/server";
import { enrich, savedPool, toCandidate } from "../recommender/candidates";
import { cuisineOf, similarity } from "../recommender/similarity";
import type { Place, Plan } from "../types";
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

export const tools = [
  betaZodTool({
    name: "recommend_options",
    description:
      "Find, availability-check and post 3 date-night options with pitches plus a WhatsApp poll to the group. Use for any 'plan / suggest / find us somewhere' request. Pass the person's wording as `request` (cuisine, area, 'near work', vibe, 'similar to X').",
    inputSchema: z.object({
      request: z.string().describe("The request in their words; empty string for a default proposal"),
      date: z.string().optional().describe("YYYY-MM-DD if known; defaults to the next usual date night"),
    }),
    run: async ({ request, date }) => {
      const { plan, message } = await proposePlan(request, { date });
      return plan ? `Posted ${plan.options.length} options and a poll for ${plan.date} ${plan.time}. Don't repeat them.` : `Posted to group: ${message}`;
    },
  }),

  betaZodTool({
    name: "book_plan_option",
    description: "Book option N (1-based) from the most recent proposed plan, e.g. when someone says 'book option 2' or 'let's do the second one'.",
    inputSchema: z.object({ option_number: z.number().int().min(1) }),
    run: async ({ option_number }) => {
      const plan = latestProposedPlan();
      if (!plan) return "There is no open proposal to book from.";
      if (option_number > plan.options.length) return `The plan only has ${plan.options.length} options.`;
      await bookOption(plan.id, option_number - 1);
      return "Booking attempted; the outcome was posted to the group.";
    },
  }),

  betaZodTool({
    name: "book_place",
    description: "Book a specific named restaurant for a date/time (only when someone explicitly asks to book it). Checks availability first.",
    inputSchema: z.object({ place_name: z.string(), ...slotFields, notes: z.string().optional() }),
    run: async ({ place_name, date, time, party_size, notes }) => {
      const place = await placeByName(place_name);
      if (!place) return `Couldn't find "${place_name}".`;
      const slot = { date, time, partySize: party_size ?? getPrefs().partySize };
      const avail = await checkAvailability(place, slot);
      if (avail.status === "unavailable") return `${place.name} is full at ${time} on ${date}. Free nearby: ${avail.alternatives?.join(", ") || "none"}.`;
      const out = await bookAndAnnounce(place, slot, { notes });
      return out.ok ? "Booked/requested; outcome posted to the group." : out.message;
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
    description: "Look up restaurants (saved or not) to answer questions. Returns facts, travel time and booking channel. Doesn't post anything.",
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
    }),
    run: async ({ reservation_id, date, time, party_size }) => modifyReservation(reservation_id, { date, time, partySize: party_size }),
  }),

  betaZodTool({
    name: "cancel_reservation",
    description: "Cancel a reservation. Only when someone in the group clearly asks to cancel it.",
    inputSchema: z.object({ reservation_id: z.number().int(), reason: z.string().optional() }),
    run: async ({ reservation_id, reason }) => cancelReservation(reservation_id, reason),
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
