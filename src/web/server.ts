import Fastify from "fastify";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, PEOPLE } from "../config";
import { kvGet, kvSet } from "../db";
import { getUser } from "../db/repo";
import { authUrl, handleCallback } from "../google/auth";
import { BOOKER } from "../google/gmail";
import { say } from "../notify";

/** Onboarding: each person connects Google and sets up a recurring Takeout export to Drive. */

function secret(): string {
  let s = kvGet<string | null>("onboard_secret", null);
  if (!s) {
    s = randomBytes(24).toString("base64url");
    kvSet("onboard_secret", s);
  }
  return s;
}

export function tokenFor(person: string): string {
  return createHmac("sha256", secret()).update(person).digest("base64url").slice(0, 22);
}

function validToken(person: string, token: string): boolean {
  const want = Buffer.from(tokenFor(person));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function onboardingLink(person: string): string {
  return `${config.publicBaseUrl}/onboard/${encodeURIComponent(person)}/${tokenFor(person)}`;
}

const TAKEOUT_URL = "https://takeout.google.com/settings/takeout/custom/saved";

function page(person: string, token: string, connected: boolean): string {
  const user = getUser(person);
  const google = connected || user?.google_tokens;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Date night planner setup</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:0 16px;color:#222}a.btn{display:inline-block;background:#1a73e8;color:#fff;padding:.6rem 1rem;border-radius:8px;text-decoration:none}li{margin:.4rem 0}.done{color:#188038}</style></head>
<body><h1>Hi ${person} 👋</h1>
<h2>1. Connect Google</h2>
${
  google
    ? `<p class="done">✓ Connected${user?.email ? ` as ${user.email}` : ""}.</p>`
    : `<p>This lets the planner read your Google Maps saved-list exports from Drive${person === BOOKER ? " and send/read reservation emails from your Gmail" : ""}.</p>
<p><a class="btn" href="/oauth/start/${encodeURIComponent(person)}/${token}">Connect Google</a></p>`
}
<h2>2. Export your saved places (once)</h2>
<ol>
<li>Open <a href="${TAKEOUT_URL}" target="_blank">Google Takeout</a>. Make sure only <b>Saved</b> is selected (click “Deselect all”, then tick “Saved”).</li>
<li>Next step → Destination: <b>Add to Drive</b>.</li>
<li>Frequency: <b>Export every 2 months for 1 year</b>. File type .zip.</li>
<li>Create export. The planner picks it up from Drive automatically (usually within an hour) and re-imports each new export.</li>
</ol>
<p>New places in between? Just paste a Google Maps link in the group and say “add this”.</p>
</body></html>`;
}

export async function startWebServer(): Promise<void> {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { person: string; token: string }; Querystring: { connected?: string } }>("/onboard/:person/:token", async (req, reply) => {
    const { person, token } = req.params;
    if (!PEOPLE.includes(person as never) || !validToken(person, token)) return reply.code(404).send("Not found");
    return reply.type("text/html").send(page(person, token, req.query.connected === "1"));
  });

  app.get<{ Params: { person: string; token: string } }>("/oauth/start/:person/:token", async (req, reply) => {
    const { person, token } = req.params;
    if (!PEOPLE.includes(person as never) || !validToken(person, token)) return reply.code(404).send("Not found");
    return reply.redirect(authUrl(`${person}:${token}`, person === BOOKER));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/oauth/callback", async (req, reply) => {
    const [person, token] = (req.query.state ?? "").split(":");
    if (!person || !token || !PEOPLE.includes(person as never) || !validToken(person, token)) return reply.code(400).send("Bad state");
    if (req.query.error || !req.query.code) return reply.code(400).send(`Google sign-in failed: ${req.query.error ?? "no code"}`);
    await handleCallback(req.query.code, person);
    await say(`🔗 ${person} connected Google.`);
    return reply.redirect(`/onboard/${encodeURIComponent(person)}/${token}?connected=1`);
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`web server on :${config.port}`);
}
