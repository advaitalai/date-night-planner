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
  vi.restoreAllMocks();
});

const slot = { date: "2026-10-21", time: "18:30", partySize: 2 };

async function savedPhonePlace() {
  const { insertPlace } = await import("../src/db/repo");
  const p = place({ name: "Warayaki", booking_channel: "phone", tablecheck_slug: null, phone: "03-1111-2222" });
  const { id: _id, ...rest } = p;
  return insertPlace(rest);
}

describe("phone calls need a go-ahead", () => {
  it("asks instead of calling when phoning is the only way", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { bookPlace } = await import("../src/booking/service");
    const { pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const out = await bookPlace(p, slot);
    expect(out.ok).toBe(false);
    expect(out.awaitingCall).toBe(true);
    expect(out.message).toContain("Shall I call them");
    expect(pendingCall()).toMatchObject({ kind: "book", placeId: p.id, slot });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("call outcome tree", () => {
  const report = (outcome: string, extra: Record<string, unknown> = {}) => ({
    outcome: { outcome, bookedTime: null, alternativeTimes: [], cancellationPolicy: null, requirements: null, summaryEn: "summary", ...extra },
    transcript: "",
  });

  it("offers to call back for a time the restaurant offered", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("full", { alternativeTimes: ["19:00"] }) as never);
    expect(msg).toContain("They offered *19:00*");
    expect(msg).toContain("call back and book 19:00");
    expect(pendingCall()?.alternatives).toEqual(["19:00"]);
  });

  it("suggests retrying a busy line in 30 minutes", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("busy") as never);
    expect(msg).toContain("busy");
    expect(pendingCall()?.suggestDelayMin).toBe(30);
  });

  it("refuses course or card conditions without proposing another call", async () => {
    const { outcomeMessage, pendingCall } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, report("declined", { requirements: "a ¥12,000 course" }) as never);
    expect(msg).toContain("seats-only");
    expect(pendingCall()).toBeNull();
  });

  it("explains a call that never connected, with the fix", async () => {
    const { outcomeMessage } = await import("../src/booking/calls");
    const p = await savedPhonePlace();
    const msg = outcomeMessage({ kind: "book", placeId: p.id, slot }, p, { ...report("failed"), failure: "Twilio balance is $0.12." } as never);
    expect(msg).toContain("couldn't place the call");
    expect(msg).toContain("Twilio balance is $0.12.");
  });
});

describe("reading how a call ended", () => {
  it("maps Vapi's ended reasons before reading the transcript", async () => {
    const { outcomeFromEndedReason } = await import("../src/booking/phone");
    expect(outcomeFromEndedReason("customer-busy", "")).toBe("busy");
    expect(outcomeFromEndedReason("customer-did-not-answer", "")).toBe("no_answer");
    expect(outcomeFromEndedReason("call.start.error-get-transport", "")).toBe("failed");
    expect(outcomeFromEndedReason("assistant-said-end-call-phrase", "AI: Hello")).toBeNull();
  });

  it("explains a Twilio transport failure in plain words", async () => {
    const { explainCallFailure } = await import("../src/booking/phone");
    const msg = await explainCallFailure("call.start.error-get-transport");
    expect(msg).toMatch(/Twilio didn't connect the call/);
  });
});
