/**
 * 1 Nov retro: one answer per message, and no system words in messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, place } from "./helpers";

beforeEach(() => freshDb());
afterEach(() => vi.restoreAllMocks());

describe("one answer per message", () => {
  it("when nothing fits, posts nothing and hands the reasons to the agent to widen once", async () => {
    const { setSender } = await import("../src/notify");
    const sent: string[] = [];
    setSender({ text: async (t) => (sent.push(t), "m"), edit: async () => {}, remove: async () => {} });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const { proposePlan } = await import("../src/recommender");
    const out = await proposePlan("");
    expect(sent.filter((t) => !t.startsWith("⏳"))).toEqual([]);
    expect(out.facts).toMatch(/^NOT POSTED: nothing fit/);
    expect(out.facts).toContain("call recommend_options once more with a wider search");
    expect(out.facts).toContain("Nothing fits");
  });
});

describe("call messages in plain words", () => {
  const slot = { date: "2026-11-01", time: "18:00", partySize: 2 };

  it("a busy line says so without Vapi's code", async () => {
    const { readOutcome } = await import("../src/booking/phone");
    const { outcomeMessage } = await import("../src/booking/calls");
    const outcome = await readOutcome("", "customer-busy", "book 2");
    const msg = outcomeMessage({ kind: "book", placeId: 1, slot }, place({ name: "Butter Note" }), { outcome, transcript: "" });
    expect(msg).toContain("*Butter Note*'s line was busy.");
    expect(msg).not.toMatch(/Ended:|customer-busy/);
  });

  it("closed reads naturally", async () => {
    const { outcomeMessage } = await import("../src/booking/calls");
    const outcome = { outcome: "closed" as const, bookedTime: null, alternativeTimes: [], cancellationPolicy: null, requirements: null, summaryEn: "They said they're closed today." };
    const msg = outcomeMessage({ kind: "book", placeId: 1, slot }, place({ name: "Butter Note" }), { outcome, transcript: "" });
    expect(msg).toContain("*Butter Note* said they're closed.");
    expect(msg).not.toContain("closed then");
  });
});
