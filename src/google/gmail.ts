import { google, type gmail_v1 } from "googleapis";
import { clientFor } from "./auth";

/** Whose Gmail sends reservation emails and receives confirmations. */
export const BOOKER = "Advait";

function gmail(): gmail_v1.Gmail {
  const auth = clientFor(BOOKER);
  if (!auth) throw new Error(`${BOOKER} hasn't connected Gmail yet (send "@planner setup")`);
  return google.gmail({ version: "v1", auth });
}

function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export function buildRaw(opts: { to: string; from?: string; subject: string; body: string; inReplyTo?: string }): string {
  const headers = [
    `To: ${opts.to}`,
    ...(opts.from ? [`From: ${opts.from}`] : []),
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
  ];
  const mime = `${headers.join("\r\n")}\r\n\r\n${Buffer.from(opts.body, "utf8").toString("base64")}`;
  return Buffer.from(mime).toString("base64url");
}

export async function sendEmail(opts: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string }) {
  const res = await gmail().users.messages.send({
    userId: "me",
    requestBody: { raw: buildRaw(opts), threadId: opts.threadId },
  });
  return { threadId: res.data.threadId!, messageId: res.data.id! };
}

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  text: string;
}

function header(m: gmail_v1.Schema$Message, name: string): string {
  return m.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function bodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = bodyText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

function toMail(m: gmail_v1.Schema$Message): MailMessage {
  return {
    id: m.id!,
    threadId: m.threadId!,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    messageIdHeader: header(m, "Message-ID"),
    text: bodyText(m.payload).slice(0, 8000),
  };
}

export async function threadMessages(threadId: string): Promise<MailMessage[]> {
  const res = await gmail().users.threads.get({ userId: "me", id: threadId, format: "full" });
  return (res.data.messages ?? []).map(toMail);
}

export async function searchMail(q: string, max = 10): Promise<MailMessage[]> {
  const list = await gmail().users.messages.list({ userId: "me", q, maxResults: max });
  const out: MailMessage[] = [];
  for (const { id } of list.data.messages ?? []) {
    const m = await gmail().users.messages.get({ userId: "me", id: id!, format: "full" });
    out.push(toMail(m.data));
  }
  return out;
}

export async function myAddress(): Promise<string> {
  const res = await gmail().users.getProfile({ userId: "me" });
  return res.data.emailAddress ?? "";
}
