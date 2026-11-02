/**
 * Bug from 1 Nov (Pulcino): the transcriber misheard 11月1日 as 1月1日, the call
 * summary called it a mistake by the assistant, and Concierge repeated it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, place } from "./helpers";

const seen: { system: string; user: string }[] = [];
vi.mock("../src/llm", async (orig) => ({
  ...(await orig<typeof import("../src/llm")>()),
  extract: async (_s: unknown, system: string, user: string) => (seen.push({ system, user }), { outcome: "unclear", bookedTime: null, alternativeTimes: [], cancellationPolicy: null, requirements: null, summaryEn: "x" }),
}));

beforeEach(() => {
  freshDb();
  seen.length = 0;
  process.env.VAPI_API_KEY = "test";
  process.env.VAPI_PHONE_NUMBER_ID = "test";
});
afterEach(() => {
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_TRANSCRIBER;
  vi.restoreAllMocks();
});

const slot = { date: "2026-11-01", time: "19:00", partySize: 2 };

describe("call transcripts can mishear", () => {
  it("the summary gets the real opening line and is told the transcript can mishear", async () => {
    const { readOutcome } = await import("../src/booking/phone");
    await readOutcome("AI: 1月1日、日曜日…昔のみ", "customer-ended-call", "book 2", "11月1日、日曜日、午後7時から2名、席のみ");
    expect(seen[0].user).toContain("Opening line, as actually spoken: 11月1日、日曜日、午後7時から2名、席のみ");
    expect(seen[0].user).toMatch(/Today: \d{4}-\d{2}-\d{2}/);
    expect(seen[0].system).toMatch(/never report that the assistant misspoke/);
  });

  it("Japanese calls use ElevenLabs Scribe; VAPI_TRANSCRIBER=deepgram goes back", async () => {
    const bodies: { assistant: { transcriber: Record<string, string> } }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), new Response(JSON.stringify({ id: "c1", status: "queued" }))));
    const { startCall, bookingScript } = await import("../src/booking/phone");
    const contact = { name: "Advait", nameKana: "", phone: "090-1234-5678", email: "a@example.com" } as never;
    await startCall("03-0000-0000", bookingScript(place({ name: "Pulcino" }), slot, contact, "ja"));
    expect(bodies[0].assistant.transcriber).toEqual({ provider: "11labs", model: "scribe_v2_realtime", language: "ja" });
    process.env.VAPI_TRANSCRIBER = "deepgram";
    await startCall("03-0000-0000", bookingScript(place({ name: "Pulcino" }), slot, contact, "ja"));
    expect(bodies[1].assistant.transcriber.provider).toBe("deepgram");
  });

  it("every call's log line links to its page in the Vapi dashboard", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { logCall } = await import("../src/logbook");
    logCall({ placeId: 1, placeName: "Pulcino", kind: "book", toNumber: "+81...", vapiId: "abc-123", outcome: "unclear", summary: "s", dryRun: false });
    expect(lines[0]).toContain("Call (audio): https://dashboard.vapi.ai/calls/abc-123");
  });
});
