/** Fixes from live UAT round 2 (20 Oct). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, place } from "./helpers";

beforeEach(() => {
  freshDb();
  process.env.VAPI_API_KEY = "test";
  process.env.VAPI_PHONE_NUMBER_ID = "test";
});
afterEach(() => {
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.CALL_FAKE;
  vi.restoreAllMocks();
});

async function saved(overrides: Parameters<typeof place>[0] = {}) {
  const { insertPlace } = await import("../src/db/repo");
  const { id: _id, ...rest } = place(overrides);
  return insertPlace(rest);
}

describe("booking a place from open options settles them", () => {
  it("stops the bot listening for a decision on options once one of them is booked (even by name, on another day)", async () => {
    process.env.CALL_FAKE = "booked";
    const { createPlan } = await import("../src/db/repo");
    const { bookPlace } = await import("../src/booking/service");
    const { openProposal } = await import("../src/agent/tools");
    const shiva = await saved({ name: "Shiva Curry Wara", booking_channel: "phone", tablecheck_slug: null, phone: "03-0000-0000" });
    const gyoro = await saved({ name: "GyoroGyoro" });
    createPlan({ date: "2026-10-21", time: "18:30", party_size: 2, status: "proposed", request: null, options: [gyoro, shiva].map((p) => ({ placeId: p.id, name: p.name, availability: "unchecked" as const, pitch: "", score: 1 })) });
    expect(openProposal()).toBeTruthy();
    await bookPlace(shiva, { date: "2026-10-22", time: "19:00", partySize: 2 }, { callApproved: true });
    expect(openProposal()).toBeUndefined();
  });
});

describe("no filler options", () => {
  it("doesn't post options when none has what was asked for", async () => {
    const { nothingMatches } = await import("../src/recommender");
    const { EMPTY_CONSTRAINTS } = await import("../src/recommender/parseRequest");
    const k = { ...EMPTY_CONSTRAINTS, vibe: ["listening bar"] };
    const pizza = place({ name: "PIZZERIA BRUNA", profile: { summary: "Neapolitan pizza", vibeTags: ["buzzy"], highlights: [], signatureDishes: [], cuisine: "pizza" } as never });
    const bar = place({ name: "JBS", profile: { summary: "a tiny listening bar", vibeTags: ["listening bar"], highlights: [], signatureDishes: [], cuisine: "bar" } as never });
    expect(nothingMatches(k, ["listening bar"], [pizza])).toBe(true);
    expect(nothingMatches(k, ["listening bar"], [pizza, bar])).toBe(false);
    expect(nothingMatches(EMPTY_CONSTRAINTS, [], [pizza])).toBe(false);
  });
});

describe("travel is measured from home", () => {
  it("treats 'anywhere in Tokyo' as home, not Tokyo Station", async () => {
    const { resolveAnchor } = await import("../src/recommender");
    const { EMPTY_CONSTRAINTS } = await import("../src/recommender/parseRequest");
    for (const q of ["Tokyo", "anywhere", "all of Tokyo", "東京"]) {
      expect((await resolveAnchor({ ...EMPTY_CONSTRAINTS, anchor: "other", anchorQuery: q })).label).toBe("home");
    }
  });
});

describe("the same place saved twice", () => {
  it("merges into the one already known instead of failing every time", async () => {
    const { config } = await import("../src/config");
    const { enrich } = await import("../src/recommender/candidates");
    const { getPlace } = await import("../src/db/repo");
    const before = config.google.mapsKey;
    config.google.mapsKey = "test";
    const advaits = await saved({ name: "Nakayoshi", google_place_id: "gp-1", cid: "111", saved_by: ["Advait"] });
    const emilys = await saved({ name: "Nakayoshi Shibuya", google_place_id: null, cid: "222", saved_by: ["Emily"], lat: 35.66, lng: 139.7 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ places: [{ id: "gp-1", displayName: { text: "Nakayoshi" }, googleMapsUri: "https://maps.google.com/?cid=111", location: { latitude: 35.66, longitude: 139.7 } }] })));
    const out = await enrich(emilys, { lite: true });
    config.google.mapsKey = before;
    expect(out.id).toBe(advaits.id);
    expect(out.saved_by.sort()).toEqual(["Advait", "Emily"]);
    expect(getPlace(emilys.id)!.booking_channel).toBe("not_restaurant");
  });
});

describe("change-a-booking call script", () => {
  it("says the old and new times as words (it said 'change that to 20 dollars' for 20:00)", async () => {
    const { config } = await import("../src/config");
    const { modifyScript } = await import("../src/booking/phone");
    const before = { lang: process.env.CALL_LANGUAGE, dry: config.dryRun };
    process.env.CALL_LANGUAGE = "en";
    config.dryRun = true;
    const r = { id: 1, date: "2026-10-22", time: "19:00", party_size: 2 } as never;
    const contact = { name: "Advait", nameKana: "", phone: "090-1234-5678", email: "a@example.com" };
    const en = modifyScript(r, place({ name: "Shiva Curry Wara" }), { date: "2026-10-22", time: "20:00", partySize: 2 }, contact);
    expect(en.firstMessage).toContain("about a reservation");
    expect(en.systemPrompt).toContain("Thursday, October 22nd at 7 p.m., two people");
    expect(en.systemPrompt).toContain("changed to Thursday, October 22nd at 8 p.m. for two people");
    expect(en.systemPrompt).not.toMatch(/\b20:00\b|\b19:00\b/);
    config.dryRun = false; // real calls are Japanese
    const ja = modifyScript(r, place({ name: "Shiva Curry Wara" }), { date: "2026-10-22", time: "20:00", partySize: 2 }, contact);
    expect(ja.systemPrompt).toContain("10月22日、木曜日、午後7時、2名）を、10月22日、木曜日、午後8時、2名に変更");
    expect(ja.firstMessage).toContain("予約の件でお電話");
    if (before.lang === undefined) delete process.env.CALL_LANGUAGE;
    else process.env.CALL_LANGUAGE = before.lang;
    config.dryRun = before.dry;
  });
});

describe("English names on cards, Japanese for calls", () => {
  it("shows Google's English name for a place saved in Japanese, and keeps the Japanese", async () => {
    const { namesFor } = await import("../src/util/geo");
    expect(namesFor("カレバカ世紀", "Karebaka Seiki")).toEqual({ name: "Karebaka Seiki", name_local: "カレバカ世紀" });
    expect(namesFor("PIZZERIA BRUNA", "Pizzeria Bruna")).toEqual({ name: "PIZZERIA BRUNA" }); // saved English name wins
    expect(namesFor("カレバカ世紀", "カレバカ世紀")).toEqual({ name: "カレバカ世紀" }); // no English name on Google
  });

  it("renames on lookup, and also backfills places looked up before", async () => {
    const { config } = await import("../src/config");
    const { enrich } = await import("../src/recommender/candidates");
    const { findPlaceByName } = await import("../src/db/repo");
    const before = config.google.mapsKey;
    config.google.mapsKey = "test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("searchText")
        ? new Response(JSON.stringify({ places: [{ id: "gp-9", displayName: { text: "Karebaka Seiki" }, googleMapsUri: "https://maps.google.com/?cid=9", location: { latitude: 35.63, longitude: 139.71 } }] }))
        : new Response(JSON.stringify({ id: "gp-8", displayName: { text: "Randan" } })),
    );
    const fresh = await enrich(await saved({ name: "カレバカ世紀", google_place_id: null, cid: "9" }), { lite: true });
    const old = await enrich(await saved({ name: "もつ焼き専門店 ランダン", google_place_id: "gp-8", cid: "8" }), { lite: true });
    config.google.mapsKey = before;
    expect(fresh).toMatchObject({ name: "Karebaka Seiki", name_local: "カレバカ世紀" });
    expect(old).toMatchObject({ name: "Randan", name_local: "もつ焼き専門店 ランダン" });
    expect(findPlaceByName("カレバカ世紀")?.name).toBe("Karebaka Seiki"); // "book カレバカ世紀" still finds it
  });

  it("uses the Japanese name on Japanese calls and the English one on English calls", async () => {
    const { bookingScript } = await import("../src/booking/phone");
    const p = place({ name: "Shiva Curry Wara", name_local: "シバカリーワラ" });
    const c = { name: "Advait", nameKana: "", phone: "090-1234-5678", email: "a@example.com" };
    const slot = { date: "2026-10-23", time: "18:30", partySize: 2 };
    expect(bookingScript(p, slot, c, "ja").firstMessage).toContain("シバカリーワラ様でしょうか");
    expect(bookingScript(p, slot, c, "en").firstMessage).toContain("is this Shiva Curry Wara?");
  });
});
