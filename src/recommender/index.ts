import { checkAvailability } from "../booking/service";
import type { Slot } from "../booking/types";
import { config, voters } from "../config";
import { createPlan, findPlaceByName, getPrefs, getPlace, recentVisits, updatePlan } from "../db/repo";
import { clearStatus, poll, say, status } from "../notify";
import { geocode } from "../places/google";
import type { Anchor, Place, Plan, PlanOption } from "../types";
import { estimateTravelMin } from "../util/geo";
import { fmtDate, nextWeekday, now } from "../util/time";
import { discover, enrich, savedPool, toCandidate } from "./candidates";
import { applyFilters, type Candidate, type FilterResult, type RejectReason } from "./filters";
import { EMPTY_CONSTRAINTS, parseRequest, type Constraints } from "./parseRequest";
import { writePitches } from "./pitch";
import { pickDiverse, scoreCandidate, type Scored } from "./score";
import { cuisineOf } from "./similarity";

export interface RecommendOption {
  scored: Scored;
  availability: "available" | "unconfirmed" | "unchecked";
}

export interface RecommendResult {
  slot: Slot;
  anchor: Anchor;
  constraints: Constraints;
  options: RecommendOption[];
  rejectedCounts: Partial<Record<RejectReason | "fully_booked" | "unsupported_flow" | "courses_only", number>>;
  /** A few place names per reason, for explaining an empty result. */
  rejectedExamples: Partial<Record<RejectReason | "fully_booked" | "unsupported_flow" | "courses_only", string[]>>;
  /** Booking channels of the places rejected as not bookable. */
  notBookableChannels: Record<string, number>;
  /** Limits loosened automatically because too few places passed. */
  relaxed: string[];
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
  const settings = { maxTravelMin: maxTravel, revisitCooldownWeeks: prefs.revisitCooldownWeeks, budgetPerPersonMaxJpy: prefs.budgetPerPersonMaxJpy };

  // Widening rounds: usual limits first, then looser ones (only limits the request didn't set).
  const rounds = [settings];
  if (k.maxTravelMin == null || k.budgetPerPersonMaxJpy == null) {
    const loosen = (extraMin: number, budgetX: number | null) => ({
      ...settings,
      maxTravelMin: k.maxTravelMin ?? maxTravel + extraMin,
      budgetPerPersonMaxJpy: k.budgetPerPersonMaxJpy ?? (budgetX == null || settings.budgetPerPersonMaxJpy == null ? null : Math.round(settings.budgetPerPersonMaxJpy * budgetX)),
    });
    rounds.push(loosen(10, 1.5), loosen(20, null));
  }
  const widest = rounds[rounds.length - 1].maxTravelMin;

  // 1. Candidates: both saved lists, plus new places found around the anchor.
  await status(`Looking through your saved places and new spots near ${anchor.label} for ${fmtDate(slot.date)} ${slot.time}…`);
  let pool = savedPool();
  if (!k.onlySaved) pool = [...pool, ...(await discover(k, anchor, slot, Math.min(6000, 1500 + widest * 120)))];
  const unique = new Map(pool.map((p) => [p.id, p]));
  const near = [...unique.values()].filter((p) => p.lat == null || estimateTravelMin(anchor, { lat: p.lat, lng: p.lng! }) <= widest + 10);
  const enriched = await mapLimit(near, 6, (p) => enrich(p, { lite: true }));

  let similarTo: Place | null = null;
  if (k.similarTo) {
    const hit = findPlaceByName(k.similarTo);
    similarTo = hit ? await enrich(hit) : null;
  }

  // 2. Filters: open then, close enough, in budget, matching the request, and some way to book.
  await status(`Checking opening hours and travel times for ${enriched.length} places…`);
  const cands = (await mapLimit(enriched, 6, (p) => toCandidate(p, anchor, slot))).filter((c): c is Candidate => c !== null);
  let kept: Candidate[] = [];
  let rejected: FilterResult["rejected"] = [];
  const relaxed: string[] = [];
  for (const [i, round] of rounds.entries()) {
    ({ kept, rejected } = applyFilters(cands, k, round));
    if (i > 0) {
      relaxed.length = 0;
      if (round.maxTravelMin !== settings.maxTravelMin) relaxed.push(`up to ${round.maxTravelMin} min away`);
      if (round.budgetPerPersonMaxJpy !== settings.budgetPerPersonMaxJpy) relaxed.push(round.budgetPerPersonMaxJpy == null ? "any budget" : `up to ¥${round.budgetPerPersonMaxJpy.toLocaleString()} a head`);
    }
    if (kept.length >= n) break;
  }

  const rejectedCounts: RecommendResult["rejectedCounts"] = {};
  const rejectedExamples: RecommendResult["rejectedExamples"] = {};
  const notBookableChannels: Record<string, number> = {};
  for (const r of rejected) {
    rejectedCounts[r.reason] = (rejectedCounts[r.reason] ?? 0) + 1;
    const ex = (rejectedExamples[r.reason] ??= []);
    if (ex.length < 3) ex.push(r.candidate.place.name);
    if (r.reason === "not_bookable") notBookableChannels[r.candidate.place.booking_channel] = (notBookableChannels[r.candidate.place.booking_channel] ?? 0) + 1;
  }

  // 3. Score (cuisine rotation, lists, ratings, similarity, distance) and pick varied options.
  const recentCuisines = recentVisits(prefs.cuisineCooldownDates)
    .map((v) => v.cuisine ?? cuisineOf(getPlace(v.place_id)!))
    .filter((c): c is string => !!c);
  const scored = kept
    .map((c) => scoreCandidate(c, { constraints: k, recentCuisines, cuisineCooldownDates: prefs.cuisineCooldownDates, similarTo }))
    .sort((a, b) => b.score - a.score);
  const picks = pickDiverse(scored, n);

  // 4. Read reviews only for the picks (profiles feed the pitch). No availability check here:
  //    you choose the place first, then the bot books it.
  await status("Reading reviews for the best matches…");
  const options = await mapLimit(picks, 3, async (s) => ({ scored: { ...s, place: await enrich(s.place) }, availability: "unchecked" as const }));
  return { slot, anchor, constraints: k, options, rejectedCounts, rejectedExamples, notBookableChannels, relaxed, skippedFavourites: [] };
}

/** Run the recommender, post the options + poll, and record the plan. */
export async function proposePlan(text: string, opts: { date?: string } = {}): Promise<{ plan?: Plan; message: string }> {
  const r = await recommend(text, opts);
  if (r.options.length === 0) {
    const message = [
      `😕 *Nothing fits ${fmtDate(r.slot.date)}, ${r.slot.time} yet*`,
      r.relaxed.length ? `Even after looking ${r.relaxed.join(" and ")}, here's what ruled places out:` : "Here's what ruled places out:",
      explainRejections(r),
      "Want me to try another time or day, a different area, or a specific cuisine?",
    ].join("\n\n");
    await say(message);
    return { message };
  }

  await status("Writing up the options…");
  const pitches = await writePitches(
    r.options.map((o) => ({ option: o.scored, availability: o.availability, anchorLabel: r.anchor.label })),
    savedPool(),
  );
  const options: PlanOption[] = r.options.map((o, i) => ({
    placeId: o.scored.place.id,
    name: o.scored.place.name,
    availability: o.availability,
    what: pitches[i].what,
    why: pitches[i].why,
    pitch: `${pitches[i].what}. Why: ${pitches[i].why}`,
    score: o.scored.score,
  }));
  const plan = createPlan({ date: r.slot.date, time: r.slot.time, party_size: r.slot.partySize, status: "proposed", request: text || null, options });

  const message = formatOptions({
    header: `${fmtDate(r.slot.date)} · ${r.slot.time} · ${r.slot.partySize} people`,
    options: options.map((o, i) => ({ ...o, place: getPlace(o.placeId)!, travelMin: r.options[i].scored.travelMin, anchor: r.anchor.label })),
    notes: [
      r.relaxed.length ? `Few places fit your usual limits, so I also looked ${r.relaxed.join(" and ")}.` : "",
    ],
    solo: voters().length === 1,
  });
  await say(message);
  await clearStatus();
  let pollId: string | undefined;
  if (config.wa.polls) pollId = await poll(`Date night ${fmtDate(r.slot.date)} ${r.slot.time}`, options.map((o, i) => `${i + 1}. ${o.name}`.slice(0, 100)));
  const saved = updatePlan(plan.id, { poll_msg_id: pollId ?? null });
  return { plan: saved, message };
}

const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

/**
 * The options message: one scannable card per place (name, what, why, a
 * compact info line, map link), then how to answer. WhatsApp formatting:
 * *bold*, _italic_.
 */
export function formatOptions(input: {
  header: string;
  options: (PlanOption & { place: Place; travelMin: number; anchor: string })[];
  notes: string[];
  solo: boolean;
}): string {
  const cards = input.options.map((o, i) => {
    const p = o.place;
    const cuisine = cuisineOf(p);
    const meta = [
      cuisine ? cuisine.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
      p.price_level ? "¥".repeat(p.price_level) : null,
      p.rating ? `★ ${p.rating}` : null,
      `${o.travelMin} min from ${o.anchor}`,
    ]
      .filter(Boolean)
      .join("  ·  ");
    return [
      `${NUM[i] ?? `${i + 1}.`} *${o.name}*`,
      `_${meta}_`,
      o.what ? `${o.what.replace(/\.$/, "")}.` : "",
      o.why ? `*Why:* ${o.why.replace(/\.$/, "")}.` : "",
      p.maps_url ? `📍 ${p.maps_url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const notes = input.notes.filter(Boolean).map((n) => `_${n}_`);
  const ask = input.solo
    ? "Reply with a number, or tell me what you'd prefer (\"somewhere closer\", \"something Japanese\")."
    : "Reply with a number, either of you, or tell me what you'd prefer. I'll book once you both agree.";
  return [`🍷 *${input.header}*`, ...cards, ...notes, `${ask}\nI'll book seats only, never a set course.`].join("\n\n");
}

const REASON_LABEL: Record<string, string> = {
  too_far: "too far",
  closed: "closed then",
  not_bookable: "have no way to book",
  over_budget: "over budget",
  visited_recently: "visited recently",
  cuisine: "didn't match the cuisine",
  excluded: "ruled out",
  fully_booked: "fully booked",
  unsupported_flow: "use a TableCheck booking flow I can't complete yet",
  courses_only: "only take course bookings or need a card",
};

const CHANNEL_LABEL: Record<string, string> = {
  phone: "phone-only",
  walkin: "walk-in only",
  other_online: "other booking sites",
  unknown: "no booking info found",
  not_restaurant: "not restaurants",
};

/** "20 too far (e.g. A, B), 12 I can't book them myself — 6 phone-only, 4 no booking info found …" */
export function explainRejections(r: Pick<RecommendResult, "rejectedCounts" | "rejectedExamples" | "notBookableChannels">): string {
  return Object.entries(r.rejectedCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      const ex = r.rejectedExamples[reason as keyof typeof r.rejectedExamples];
      const channels =
        reason === "not_bookable"
          ? ` (${Object.entries(r.notBookableChannels)
              .map(([c, n]) => `${n} ${CHANNEL_LABEL[c] ?? c}`)
              .join(", ")})`
          : "";
      return `• *${count}* ${REASON_LABEL[reason] ?? reason}${channels}${ex?.length ? `\n   e.g. ${ex.join(", ")}` : ""}`;
    })
    .join("\n");
}
