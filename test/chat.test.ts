import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";

// No real AI in unit tests: the listener's "have they decided?" answer is scripted.
const decided = vi.hoisted(() => ({ option: null as number | null }));
vi.mock("../src/llm", async (orig) => ({
  ...(await orig<typeof import("../src/llm")>()),
  extract: async () => ({ decided_option: decided.option }),
}));

beforeEach(() => {
  freshDb();
  decided.option = null;
});

const msg = (text: string, quoted?: string) =>
  ({
    key: { remoteJid: "group@g.us", id: "x" },
    message: quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: "q1", quotedMessage: { conversation: quoted } } } } : { conversation: text },
  }) as never;

describe("who the bot answers", () => {
  it("answers inline replies to its own messages and 'planner', nothing else", async () => {
    const { config } = await import("../src/config");
    const { isAddressed } = await import("../src/wa/whatsapp");
    Object.assign(config.wa, { groupJid: "group@g.us", solo: false, selfMode: true });
    expect(isAddressed(msg("ooh 2 looks good"), "ooh 2 looks good")).toBe(false);
    expect(isAddressed(msg("yes go ahead", "Emily: which one?"), "yes go ahead")).toBe(false);
    expect(isAddressed(msg("yes go ahead", "🤖 Shall I book *Suan Sawan*?"), "yes go ahead")).toBe(true);
    expect(isAddressed(msg("planner plan wednesday"), "planner plan wednesday")).toBe(true);
  });
});

describe("listening to the two of them", () => {
  async function openPlan() {
    const { createPlan } = await import("../src/db/repo");
    return createPlan({
      date: "2026-10-21",
      time: "18:30",
      party_size: 2,
      status: "proposed",
      request: null,
      options: ["Suan Sawan", "h:armonia"].map((name, i) => ({ placeId: i + 1, name, availability: "available" as const, pitch: "", score: 1 })),
    });
  }

  it("stays quiet with no open options", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    decided.option = 1;
    expect(await handleMessage("Emily", "let's do 1", { addressed: false })).toBeNull();
  });

  it("stays quiet while they're still deciding", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    await openPlan();
    expect(await handleMessage("Advait", "what do you think of 1?", { addressed: false })).toBeNull();
  });

  it("asks once to confirm when they've decided, and books nothing", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    const { db } = await import("../src/db");
    await openPlan();
    decided.option = 1;
    const reply = await handleMessage("Emily", "yes let's do Suan Sawan", { addressed: false });
    expect(reply).toContain("Sounds like *Suan Sawan*");
    expect(reply).toContain("Shall I book it?");
    expect(await handleMessage("Advait", "yay", { addressed: false })).toBeNull();
    expect((db().prepare("SELECT COUNT(*) AS n FROM booking_log").get() as { n: number }).n).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM call_log").get() as { n: number }).n).toBe(0);
  });
});
