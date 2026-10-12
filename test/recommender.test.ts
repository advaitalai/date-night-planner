import { describe, expect, it } from "vitest";
import { applyFilters, type Candidate } from "../src/recommender/filters";
import { EMPTY_CONSTRAINTS } from "../src/recommender/parseRequest";
import { pickDiverse, scoreCandidate, type ScoreContext } from "../src/recommender/score";
import { cuisineMatch, mostSimilarSaved, similarity } from "../src/recommender/similarity";
import { place } from "./helpers";

const settings = { maxTravelMin: 25, revisitCooldownWeeks: 8, budgetPerPersonMaxJpy: 15000 };

function cand(overrides: Parameters<typeof place>[0] = {}, c: Partial<Candidate> = {}): Candidate {
  return { place: place(overrides), travelMin: 12, travelEstimated: false, openAtSlot: true, lastVisitDaysAgo: null, ...c };
}

const ctx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
  constraints: EMPTY_CONSTRAINTS,
  recentCuisines: [],
  cuisineCooldownDates: 3,
  similarTo: null,
  ...over,
});

describe("filters", () => {
  it("treats any place with a phone number as bookable (AI call)", () => {
    expect(applyFilters([cand({ booking_channel: "phone", tablecheck_slug: null, phone: "03-1234-5678" })], EMPTY_CONSTRAINTS, settings).kept).toHaveLength(1);
  });

  it("keeps a bookable, open, nearby place", () => {
    expect(applyFilters([cand()], EMPTY_CONSTRAINTS, settings).kept).toHaveLength(1);
  });

  it.each([
    ["not_bookable", cand({ booking_channel: "walkin", tablecheck_slug: null })],
    ["closed", cand({}, { openAtSlot: false })],
    ["too_far", cand({}, { travelMin: 40 })],
    ["visited_recently", cand({}, { lastVisitDaysAgo: 14 })],
    ["over_budget", cand({ price_level: 4 })],
  ])("rejects %s", (reason, c) => {
    expect(applyFilters([c], EMPTY_CONSTRAINTS, settings).rejected[0].reason).toBe(reason);
  });

  it("applies requested cuisine and travel limit", () => {
    const k = { ...EMPTY_CONSTRAINTS, cuisines: ["italian"], maxTravelMin: 15 };
    const r = applyFilters(
      [cand({ cuisine: "italian" }), cand({ cuisine: "indian" }), cand({ cuisine: "italian" }, { travelMin: 20 })],
      k,
      settings,
    );
    expect(r.kept.map((c) => c.place.cuisine)).toEqual(["italian"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["cuisine", "too_far"]);
  });

  it("allows unknown opening hours", () => {
    expect(applyFilters([cand({}, { openAtSlot: null })], EMPTY_CONSTRAINTS, settings).kept).toHaveLength(1);
  });

  it.each([
    ["a dessert-course counter", cand({ cuisine: "Dessert Course" })],
    ["a café", cand({ primary_type: "cafe" })],
    ["a place Google says doesn't serve dinner", cand({ features: { servesDinner: false } })],
  ])("drops %s for dinner", (_label, c) => {
    expect(applyFilters([c], EMPTY_CONSTRAINTS, settings).rejected[0].reason).toBe("not_dinner");
  });

  it("keeps dessert places when dessert is what they asked for", () => {
    expect(applyFilters([cand({ cuisine: "Dessert Course" })], { ...EMPTY_CONSTRAINTS, cuisines: ["dessert"] }, settings).kept).toHaveLength(1);
  });

  it("treats must-haves as hard filters (Google attribute or reviews)", () => {
    const k = { ...EMPTY_CONSTRAINTS, features: ["live_music" as const] };
    const byAttr = cand({ name: "Jazz", features: { liveMusic: true } });
    const byReview = cand({ name: "Band", profile: { cuisine: "american", vibeTags: ["live band"], signatureDishes: [], highlights: [], priceBand: "mid", summary: "" } });
    const unknown = cand({ name: "Quiet" });
    const no = cand({ name: "No", features: { liveMusic: false } });
    const r = applyFilters([byAttr, byReview, unknown, no], k, settings);
    expect(r.kept.map((c) => c.place.name)).toEqual(["Jazz", "Band"]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["missing_feature", "missing_feature"]);
  });

  it("leaves out places already suggested for that date", () => {
    const shown = cand({ name: "Shown" });
    const r = applyFilters([shown, cand({ name: "New" })], EMPTY_CONSTRAINTS, { ...settings, excludeIds: new Set([shown.place.id]) });
    expect(r.kept.map((c) => c.place.name)).toEqual(["New"]);
    expect(r.rejected[0].reason).toBe("shown_before");
  });
});

describe("honest reporting", () => {
  it("lists asked-for cuisines that no option has", async () => {
    const { unmetParts } = await import("../src/recommender/index");
    const opt = (p: Parameters<typeof place>[0]) => ({ scored: { ...cand(p), score: 1, reasons: [] }, availability: "unchecked" as const });
    const k = { ...EMPTY_CONSTRAINTS, cuisines: ["thai", "mexican"] };
    expect(unmetParts(k, [opt({ cuisine: "thai" }), opt({ cuisine: "thai" })])).toEqual(["mexican"]);
  });
});

describe("scoring", () => {
  it("prefers places on both lists", () => {
    const both = scoreCandidate(cand({ saved_by: ["Advait", "Emily"] }), ctx());
    const one = scoreCandidate(cand({ saved_by: ["Advait"] }), ctx());
    expect(both.score).toBeGreaterThan(one.score);
    expect(both.reasons).toContain("on both your lists");
  });

  it("rotates cuisines away from recent dates", () => {
    const indian = scoreCandidate(cand({ cuisine: "indian" }), ctx({ recentCuisines: ["indian"] }));
    const thai = scoreCandidate(cand({ cuisine: "thai" }), ctx({ recentCuisines: ["indian"] }));
    expect(thai.score - indian.score).toBeGreaterThanOrEqual(2.5);
  });

  it("rewards similarity to a requested place", () => {
    const target = place({ cuisine: "italian", price_level: 3 });
    const similar = scoreCandidate(cand({ cuisine: "italian", price_level: 3 }), ctx({ similarTo: target }));
    const different = scoreCandidate(cand({ cuisine: "sushi", price_level: 1 }), ctx({ similarTo: target }));
    expect(similar.score).toBeGreaterThan(different.score + 2);
  });

  it("penalises travel time", () => {
    expect(scoreCandidate(cand({}, { travelMin: 5 }), ctx()).score).toBeGreaterThan(scoreCandidate(cand({}, { travelMin: 25 }), ctx()).score);
  });
});

describe("pickDiverse", () => {
  it("takes one per cuisine and makes room for a competitive new place", () => {
    const s = (cuisine: string, score: number, saved = true) => ({
      ...cand({ cuisine, saved_by: saved ? ["Emily"] : [] }),
      score,
      reasons: [],
    });
    const picked = pickDiverse([s("italian", 9), s("italian", 8.5), s("thai", 8), s("french", 7), s("mexican", 6.5, false)], 3);
    expect(picked.map((p) => p.place.cuisine)).toEqual(["italian", "thai", "mexican"]);
  });
});

describe("similarity", () => {
  it("matches related cuisines partially", () => {
    expect(cuisineMatch("south indian", "indian")).toBe(0.5);
    expect(cuisineMatch("italian", "italian")).toBe(1);
    expect(cuisineMatch("italian", "thai")).toBe(0);
  });

  it("finds the most similar saved place", () => {
    const profile = (cuisine: string, vibeTags: string[]) => ({ cuisine, vibeTags, signatureDishes: [], highlights: [], priceBand: "mid" as const, summary: "" });
    const bistro = place({ name: "Bistro", profile: profile("french", ["romantic", "quiet"]) });
    const ramen = place({ name: "Ramen", profile: profile("ramen", ["lively"]) });
    const cand = place({ name: "New French", saved_by: [], profile: profile("french", ["romantic"]) });
    expect(similarity(cand, bistro)).toBeGreaterThan(similarity(cand, ramen));
    expect(mostSimilarSaved(cand, [bistro, ramen])?.place.name).toBe("Bistro");
  });
});

describe("explainRejections", () => {
  it("names places and splits 'not bookable' by channel", async () => {
    const { explainRejections } = await import("../src/recommender");
    const text = explainRejections({
      rejectedCounts: { too_far: 20, not_bookable: 12 },
      rejectedExamples: { too_far: ["Canal Cafe"], not_bookable: ["Ghungroo"] },
      notBookableChannels: { phone: 8, unknown: 4 },
    });
    expect(text).toContain("• *20* too far\n   e.g. Canal Cafe");
    expect(text).toContain("• *12* have no way to book (8 phone-only, 4 no booking info found)\n   e.g. Ghungroo");
    expect(text).not.toContain("—");
  });
});

describe("options message", () => {
  it("renders one card per place with what, why, info and how to reply", async () => {
    const { formatOptions } = await import("../src/recommender");
    const msg = formatOptions({
      header: "Fri 9 Oct · 18:30 · 2 people",
      options: [
        {
          placeId: 1, name: "h:armonia", availability: "available", score: 3, pitch: "",
          what: "Handmade pasta and charcoal-grilled wagyu in a cosy Italian bar",
          why: "Saved by Advait; reviewers rave about the handmade pasta",
          place: place({ name: "h:armonia", cuisine: "italian", price_level: 2, rating: 4.6, maps_url: "https://maps.google.com/?cid=1", address: "3 Chome-1-1 Nishigotanda, Shinagawa City, Tokyo 141-0031, Japan" }),
          travelMin: 6, travelWalk: true, anchor: "home",
        },
      ],
      notes: [""],
      solo: true,
    });
    if (process.env.SHOW_SAMPLE) console.log(msg);
    expect(msg).toContain("1️⃣ *h:armonia*\n_Italian  ·  ¥¥  ·  ★ 4.6  ·  Nishigotanda, 6 min walk from home_\nHandmade pasta");
    expect(msg).toContain("*Why:* Saved by Advait; reviewers rave about the handmade pasta.");
    expect(msg).toContain("📍 https://maps.google.com/?cid=1");
    expect(msg).toContain("Reply with a number");
    expect(msg).not.toContain("—");
  });
});

describe("travel and area labels", () => {
  it("names the neighbourhood and how you'd get there", async () => {
    const { areaOf, travelLabel } = await import("../src/util/geo");
    expect(areaOf("1 Chome-2-3 Ebisu, Shibuya City, Tokyo 150-0013, Japan")).toBe("Ebisu");
    expect(areaOf("Shibuya City, Tokyo, Japan")).toBe("Shibuya");
    expect(areaOf("日本、〒141-0022 東京都品川区東五反田1-2-3")).toBe("品川区");
    expect(travelLabel(22, false, false)).toBe("22 min by train");
    expect(travelLabel(25, false, true)).toBe("~25 min by train");
    expect(travelLabel(6, true, false)).toBe("6 min walk");
  });
});
