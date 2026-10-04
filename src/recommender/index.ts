import { checkAvailability } from "../booking/service";
import type { Slot } from "../booking/types";
import { config } from "../config";
import { createPlan, findPlaceByName, getPrefs, getPlace, recentVisits, updatePlan } from "../db/repo";
import { poll, say } from "../notify";
import { geocode } from "../places/google";
import type { Anchor, Place, Plan, PlanOption } from "../types";
import { estimateTravelMin } from "../util/geo";
import { fmtDate, nextWeekday, now } from "../util/time";
import { discover, enrich, savedPool, toCandidate } from "./candidates";
import { applyFilters, type Candidate, type RejectReason } from "./filters";
import { EMPTY_CONSTRAINTS, parseRequest, type Constraints } from "./parseRequest";
import { writePitches } from "./pitch";
import { pickDiverse, scoreCandidate, type Scored } from "./score";
import { cuisineOf } from "./similarity";

export interface RecommendOption {
  scored: Scored;
  availability: "available" | "unconfirmed";
}

export interface RecommendResult {
  slot: Slot;
  anchor: Anchor;
  constraints: Constraints;
  options: RecommendOption[];
  rejectedCounts: Partial<Record<RejectReason | "fully_booked", number>>;
  /** Well-rated saved places skipped only because the bot can't book them itself. */
  skippedFavourites: Place[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function resolveAnchor(k: Constraints): Promise<Anchor> {
  const prefs = getPrefs();
  if (k.anchor === "office") return prefs.anchors.office;
  if (k.anchor === "other" && k.anchorQuery && config.google.mapsKey) {
    const ll = await geocode(`${k.anchorQuery}, Tokyo`).catch(() => null);
    if (ll) return { label: k.anchorQuery, address: k.anchorQuery, ...ll };
  }
  return prefs.anchors.home;
}

export async function recommend(text: string, opts: { date?: string; n?: number } = {}): Promise<RecommendResult> {
  const prefs = getPrefs();
  const n = opts.n ?? 3;
  const k = text.trim() ? await parseRequest(text, prefs) : EMPTY_CONSTRAINTS;
  const slot: Slot = {
    date: k.date ?? opts.date ?? nextWeekday(now(), prefs.defaultWeekday),
    time: k.time ?? prefs.defaultTime,
    partySize: k.partySize ?? prefs.partySize,
  };
  const anchor = await resolveAnchor(k);
  const maxTravel = k.maxTravelMin ?? prefs.maxTravelMin;

  // 1. Candidate pool: saved lists (+ earlier discoveries), plus fresh discoveries unless told otherwise.
  let pool = savedPool();
  if (!k.onlySaved) pool = [...pool, ...(await discover(k, anchor, slot))];
  const unique = new Map(pool.map((p) => [p.id, p]));
  // Cheap distance pre-filter before any API calls.
  const near = [...unique.values()].filter((p) => p.lat == null || estimateTravelMin(anchor, { lat: p.lat, lng: p.lng! }) <= maxTravel + 15);
  const enriched = await mapLimit(near, 4, enrich);

  let similarTo: Place | null = null;
  if (k.similarTo) {
    const hit = findPlaceByName(k.similarTo);
    similarTo = hit ? await enrich(hit) : null;
  }

  // 2. Hard filters.
  const cands = (await mapLimit(enriched, 4, (p) => toCandidate(p, anchor, slot))).filter((c): c is Candidate => c !== null);
  const settings = { maxTravelMin: maxTravel, revisitCooldownWeeks: prefs.revisitCooldownWeeks, budgetPerPersonMaxJpy: prefs.budgetPerPersonMaxJpy };
  const { kept, rejected } = applyFilters(cands, k, settings);
  const rejectedCounts: RecommendResult["rejectedCounts"] = {};
  for (const r of rejected) rejectedCounts[r.reason] = (rejectedCounts[r.reason] ?? 0) + 1;
  const skippedFavourites = rejected
    .filter((r) => r.reason === "not_bookable" && r.candidate.place.saved_by.length > 0 && ["phone", "other_online"].includes(r.candidate.place.booking_channel))
    .map((r) => r.candidate.place)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 3);

  // 3. Score with cuisine rotation.
  const recentCuisines = recentVisits(prefs.cuisineCooldownDates)
    .map((v) => v.cuisine ?? cuisineOf(getPlace(v.place_id)!))
    .filter((c): c is string => !!c);
  const scored = kept
    .map((c) => scoreCandidate(c, { constraints: k, recentCuisines, cuisineCooldownDates: prefs.cuisineCooldownDates, similarTo }))
    .sort((a, b) => b.score - a.score);

  // 4. Availability before proposing: walk down the ranking until we have n bookable options.
  const verified: Scored[] = [];
  const availability = new Map<number, RecommendOption["availability"]>();
  let unconfirmed = 0;
  for (let i = 0; i < scored.length && verified.length < n + 2; i += 4) {
    const batch = scored.slice(i, i + 4);
    const results = await Promise.all(batch.map((s) => checkAvailability(s.place, slot)));
    batch.forEach((s, j) => {
      const r = results[j];
      if (r.status === "available") {
        verified.push(s);
        availability.set(s.place.id, "available");
      } else if (r.status === "unknown" && s.place.booking_channel === "email" && unconfirmed < 1) {
        verified.push(s);
        availability.set(s.place.id, "unconfirmed");
        unconfirmed++;
      } else if (r.status === "unavailable") {
        rejectedCounts.fully_booked = (rejectedCounts.fully_booked ?? 0) + 1;
      }
    });
  }

  const options = pickDiverse(verified, n).map((scored) => ({ scored, availability: availability.get(scored.place.id)! }));
  return { slot, anchor, constraints: k, options, rejectedCounts, skippedFavourites };
}

/** Run the recommender, post the options + poll, and record the plan. */
export async function proposePlan(text: string, opts: { date?: string } = {}): Promise<{ plan?: Plan; message: string }> {
  const r = await recommend(text, opts);
  if (r.options.length === 0) {
    const why = Object.entries(r.rejectedCounts)
      .map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
      .join(", ");
    const message = `I couldn't find a bookable table for ${fmtDate(r.slot.date)} ${r.slot.time}${why ? ` (filtered out: ${why})` : ""}. Want me to widen the area, change the time, or try another day?`;
    await say(message);
    return { message };
  }

  const pitches = await writePitches(
    r.options.map((o) => ({ option: o.scored, availability: o.availability, anchorLabel: r.anchor.label })),
    savedPool(),
  );
  const options: PlanOption[] = r.options.map((o, i) => ({
    placeId: o.scored.place.id,
    name: o.scored.place.name,
    availability: o.availability,
    pitch: pitches[i],
    score: o.scored.score,
  }));
  const plan = createPlan({ date: r.slot.date, time: r.slot.time, party_size: r.slot.partySize, status: "proposed", request: text || null, options });

  const lines = options.map((o, i) => `${i + 1}. *${o.name}*${o.availability === "unconfirmed" ? " _(availability unconfirmed)_" : ""}\n${o.pitch}${mapsLink(o.placeId)}`);
  const skipped = r.skippedFavourites.length
    ? `\n\n(Skipped ${r.skippedFavourites.map((p) => p.name).join(", ")}: phone/other booking only for now.)`
    : "";
  const message = `🍷 Options for ${fmtDate(r.slot.date)}, ${r.slot.time} (${r.slot.partySize} people, from ${r.anchor.label}). All checked for availability:\n\n${lines.join("\n\n")}${skipped}\n\nVote below 👇 I'll book as soon as you both pick the same one.`;
  await say(message);
  const pollId = await poll(`Date night ${fmtDate(r.slot.date)} ${r.slot.time}`, options.map((o, i) => `${i + 1}. ${o.name}`.slice(0, 100)));
  const saved = updatePlan(plan.id, { poll_msg_id: pollId ?? null });
  return { plan: saved, message };
}

function mapsLink(placeId: number): string {
  const p = getPlace(placeId);
  return p?.maps_url ? `\n${p.maps_url}` : "";
}
