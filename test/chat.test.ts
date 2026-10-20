import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./helpers";

// No real AI in unit tests: the listener's answers ("for the bot?", "decided?") and the agent's reply are scripted.
const decided = vi.hoisted(() => ({ option: null as number | null, forBot: false, agentRuns: 0 }));
vi.mock("../src/llm", async (orig) => ({
  ...(await orig<typeof import("../src/llm")>()),
  extract: async () => ({ for_bot: decided.forBot, decided_option: decided.option }),
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async () => (decided.agentRuns++, { stop_reason: "end_turn", content: [{ type: "text", text: "Nothing booked yet." }] }),
      },
    },
  }),
}));

beforeEach(() => {
  freshDb();
  decided.option = null;
  decided.forBot = false;
  decided.agentRuns = 0;
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

  it("answers to its WhatsApp name too (e.g. Concierge), as a word", async () => {
    const { config } = await import("../src/config");
    const { isAddressed } = await import("../src/wa/whatsapp");
    Object.assign(config.wa, { groupJid: "group@g.us", solo: false, selfMode: false, botName: "Concierge" });
    expect(isAddressed(msg("Concierge, plan wednesday"), "Concierge, plan wednesday")).toBe(true);
    expect(isAddressed(msg("hey concierge what's booked?"), "hey concierge what's booked?")).toBe(true);
    expect(isAddressed(msg("the hotel concierges were nice"), "the hotel concierges were nice")).toBe(false);
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

  it("answers a message it judges is meant for it, even without a reply or its name", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    decided.forBot = true;
    expect(await handleMessage("Advait", "What's booked?", { addressed: false })).toBe("Nothing booked yet.");
    expect(decided.agentRuns).toBe(1);
  });

  it("shows it's working (⏳ and status line) once it judges a message is for it, and not for chat between them", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    let started = 0;
    const onForBot = async () => void started++;
    decided.forBot = true;
    await handleMessage("Advait", "Show me Latin American food near home", { addressed: false, onForBot });
    expect(started).toBe(1);
    decided.forBot = false;
    await handleMessage("Advait", "Emily did you have a busy day?", { addressed: false, onForBot });
    expect(started).toBe(1);
  });

  it("doesn't wake the agent for messages between the two of them", async () => {
    const { handleMessage } = await import("../src/agent/loop");
    await openPlan();
    expect(await handleMessage("Advait", "babe which one do you like?", { addressed: false })).toBeNull();
    expect(decided.agentRuns).toBe(0);
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
