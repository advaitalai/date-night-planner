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

  it("the transcript keeps the turns in order (Vapi's grouped one lost which answer was for which question)", async () => {
    const { orderedTranscript } = await import("../src/booking/phone");
    const call = {
      id: "c", status: "ended",
      artifact: {
        transcript: "User: 満席です。 満席です。\nAI: …6時半… …7時まで…",
        messages: [
          { role: "system", message: "prompt", secondsFromStart: 0 },
          { role: "bot", message: "…6時半…ございますでしょうか。", secondsFromStart: 1 },
          { role: "user", message: "その日は満席です。", secondsFromStart: 9 },
          { role: "bot", message: "かしこまりました。", secondsFromStart: 12 },
          { role: "bot", message: "午後7時までの空きはございますでしょうか？", secondsFromStart: 13 },
          { role: "user", message: "満席です。", secondsFromStart: 18 },
        ],
      },
    };
    expect(orderedTranscript(call)).toBe("AI: …6時半…ございますでしょうか。\nUser: その日は満席です。\nAI: かしこまりました。 午後7時までの空きはございますでしょうか？\nUser: 満席です。");
    expect(orderedTranscript({ id: "c", status: "ended", artifact: { transcript: "AI: hi" } })).toBe("AI: hi");
    // The list can also sit on the call itself, with "assistant" turns.
    const top = { id: "c", status: "ended", messages: [{ role: "assistant", content: "ございますでしょうか。", time: 1 }, { role: "user", message: "満席です。", time: 2 }] };
    expect(orderedTranscript(top)).toBe("AI: ございますでしょうか。\nUser: 満席です。");
  });

  it("tells the caller never to say its reasoning out loud (it said 予約せず持ち帰る on the 2 Nov test)", async () => {
    const { bookingScript } = await import("../src/booking/phone");
    const contact = { name: "Advait", nameKana: "", phone: "090-1234-5678", email: "a@example.com" } as never;
    expect(bookingScript(place({ name: "Pulcino" }), slot, contact, "ja").systemPrompt).toMatch(/判断の理由.*絶対に口に出さない/);
    expect(bookingScript(place({ name: "Pulcino" }), slot, contact, "en").systemPrompt).toMatch(/never your reasoning/);
  });

  it("writes 席 in kana so the voice doesn't say mukashi", async () => {
    const { bookingScript } = await import("../src/booking/phone");
    const s = bookingScript(place({ name: "Pulcino" }), slot, { name: "Advait", nameKana: "", phone: "090-1234-5678", email: "a@example.com" } as never, "ja");
    expect(s.firstMessage).toContain("せきのみで予約");
    expect(s.firstMessage).toContain("おせきはございますでしょうか");
    expect(s.firstMessage).not.toContain("席");
  });

  it("every call's log line links to its page in the Vapi dashboard", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { logCall } = await import("../src/logbook");
    logCall({ placeId: 1, placeName: "Pulcino", kind: "book", toNumber: "+81...", vapiId: "abc-123", outcome: "unclear", summary: "s", dryRun: false });
    expect(lines[0]).toContain("Call (audio): https://dashboard.vapi.ai/calls/abc-123");
  });
});
