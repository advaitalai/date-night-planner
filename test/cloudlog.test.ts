import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("Cloud Logging", () => {
  it("does nothing off Google Cloud (no metadata server)", async () => {
    const { startCloudLogging, cloudLog, flushCloudLogs, _resetCloudLog } = await import("../src/cloudlog");
    _resetCloudLog();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND metadata.google.internal"));
    expect(await startCloudLogging()).toBeNull();
    cloudLog("log", "[in] Advait: hi");
    await flushCloudLogs();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the metadata probe
  });

  it("sends queued lines with the VM's token, and keeps them if sending fails", async () => {
    const { cloudLog, flushCloudLogs, _resetCloudLog } = await import("../src/cloudlog");
    _resetCloudLog("my-project");
    const sent: { url: string; body?: string; auth?: string }[] = [];
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      sent.push({ url: u, body: init?.body as string, auth: (init?.headers as Record<string, string>).Authorization });
      return fail ? new Response("unavailable", { status: 503 }) : new Response("{}");
    });
    cloudLog("log", "[in] Advait: hi");
    cloudLog("error", "agent error: boom");
    const warnings: string[] = [];
    await flushCloudLogs((m) => warnings.push(m));
    expect(warnings[0]).toMatch(/couldn't send logs/);
    fail = false;
    await flushCloudLogs();
    const body = JSON.parse(sent[1].body!);
    expect(sent[1].url).toBe("https://logging.googleapis.com/v2/entries:write");
    expect(sent[1].auth).toBe("Bearer tok");
    expect(body.logName).toBe("projects/my-project/logs/date-night-planner");
    expect(body.entries.map((e: { textPayload: string; severity: string }) => [e.severity, e.textPayload])).toEqual([
      ["INFO", "[in] Advait: hi"],
      ["ERROR", "agent error: boom"],
    ]);
    await flushCloudLogs();
    expect(sent).toHaveLength(2); // nothing left to send
    _resetCloudLog();
  });
});
