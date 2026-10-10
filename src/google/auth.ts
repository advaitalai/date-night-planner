import { google } from "googleapis";
import { config } from "../config";
import { getUser, upsertUser } from "../db/repo";

export const SCOPES = {
  /** Everyone: read Takeout exports that land in Drive. */
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  /** The booker: send reservation emails and read replies/confirmations. */
  gmail: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
};

export function oauthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, `${config.publicBaseUrl}/oauth/callback`);
}

export function authUrl(state: string, withGmail: boolean): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...SCOPES.drive, ...(withGmail ? SCOPES.gmail : []), "openid", "email"],
    state,
  });
}

export async function handleCallback(code: string, person: string): Promise<void> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  upsertUser(person, { google_tokens: JSON.stringify(tokens), email: info.data.email ?? null });
}

/** An authorized client for a person, persisting refreshed tokens. */
export function clientFor(person: string) {
  const user = getUser(person);
  if (!user?.google_tokens) return null;
  const client = oauthClient();
  const stored = JSON.parse(user.google_tokens);
  client.setCredentials(stored);
  client.on("tokens", (t) => upsertUser(person, { google_tokens: JSON.stringify({ ...stored, ...t }) }));
  return client;
}
