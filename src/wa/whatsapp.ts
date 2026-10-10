import makeWASocket, {
  DisconnectReason,
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import { createHash } from "node:crypto";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { handleMessage } from "../agent/loop";
import { config, isSelfChat, isSolo, PEOPLE } from "../config";
import { kvGet, kvSet } from "../db";
import { getPlanByPoll, getUser, logMessage, upsertUser, userByJid } from "../db/repo";
import { clearStatus, say, setSender, status } from "../notify";
import { onVotes } from "../plans/decide";

/**
 * WhatsApp via Baileys, linked as a device (WhatsApp → Linked devices).
 *
 * Two modes:
 * - self mode (default, no extra SIM): linked to Advait's own WhatsApp. The
 *   bot's messages appear as Advait with a 🤖 prefix; Advait's own messages
 *   (typed on his phone) are treated as his, and the bot ignores what it sent.
 * - bot-number mode (WA_SELF_MODE=0): linked to a separate number that's a
 *   member of the group.
 *
 * Only messages from WA_GROUP_JID are handled. The bot answers when it's
 * called "planner", replied to, or (bot-number mode) @-mentioned.
 */

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });

interface StoredPoll {
  secret: string; // base64 messageSecret
  options: string[];
  creatorJids: string[];
}

let sock: WASocket | undefined;

const BOT_PREFIX = "🤖 ";
/** Ids of messages the bot itself sent, so self mode doesn't answer itself. */
const sentByBot = new Set<string>();

/** Full keys of bot messages, needed to edit or delete them (the live status line). */
const sentKeys = new Map<string, WAMessageKey>();

function rememberSent(id: string | null | undefined): void {
  if (!id) return;
  sentByBot.add(id);
  if (sentByBot.size > 500) sentByBot.delete(sentByBot.values().next().value!);
}

function botJids(): string[] {
  const me = sock?.user;
  return [me?.id, me?.lid].filter((j): j is string => !!j).map(jidNormalizedUser);
}

/** Map a sender jid to Advait/Emily: known jid, phone number, push name, or "I'm <name>". */
function identify(jid: string, pushName?: string | null, text?: string): string | null {
  const known = userByJid(jid);
  if (known) return known.name;
  const digits = jid.split("@")[0].split(":")[0];
  let name = PEOPLE.find((p) => config.wa.phones[p] && digits === config.wa.phones[p]) ?? null;
  name ??= PEOPLE.find((p) => pushName?.toLowerCase().includes(p.toLowerCase())) ?? null;
  const claim = text?.match(/\bi['’]?m (advait|emily)\b/i)?.[1];
  if (claim) name = PEOPLE.find((p) => p.toLowerCase() === claim.toLowerCase()) ?? name;
  if (name && !getUser(name)?.wa_jid) upsertUser(name, { wa_jid: jid });
  return name;
}

function textOf(m: WAMessage): string {
  const msg = m.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? msg?.imageMessage?.caption ?? "";
}

/** The chat the bot lives in: the configured group, or Advait's own chat in self-chat mode. */
function chatJid(): string {
  return isSelfChat() ? jidNormalizedUser(sock?.user?.id) : config.wa.groupJid;
}

function isOurChat(remoteJid: string | null | undefined): boolean {
  if (!remoteJid) return false;
  // The "Message yourself" chat can appear under the phone-number jid or the LID.
  return isSelfChat() ? botJids().includes(jidNormalizedUser(remoteJid)) : remoteJid === config.wa.groupJid;
}

function isAddressed(m: WAMessage, text: string): boolean {
  if (isSolo()) return true;
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  if (ctx?.stanzaId && sentByBot.has(ctx.stanzaId)) return true;
  if (!config.wa.selfMode) {
    // In self mode a mention of the bot is a mention of Advait, so only the keyword counts.
    const mine = botJids();
    if (ctx?.mentionedJid?.some((j) => mine.includes(jidNormalizedUser(j)))) return true;
    if (ctx?.participant && mine.includes(jidNormalizedUser(ctx.participant))) return true;
  }
  return /\bplanner\b/i.test(text);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Decrypt a poll vote and record it on the matching plan. */
async function handlePollVote(m: WAMessage): Promise<void> {
  const upd = m.message?.pollUpdateMessage;
  const pollId = upd?.pollCreationMessageKey?.id;
  if (!upd?.vote || !pollId) return;
  const poll = kvGet<StoredPoll | null>(`poll:${pollId}`, null);
  const plan = getPlanByPoll(pollId);
  if (!poll || !plan) return;

  const voterCandidates = [getKeyAuthor(m.key), m.key.participant, ...(m.key.fromMe ? botJids() : [])]
    .filter((j): j is string => !!j)
    .map(jidNormalizedUser);
  let selected: Uint8Array[] | null = null;
  let voterJid = "";
  outer: for (const creator of poll.creatorJids) {
    for (const voter of voterCandidates) {
      try {
        const vote = decryptPollVote(upd.vote, { pollEncKey: Buffer.from(poll.secret, "base64"), pollCreatorJid: creator, pollMsgId: pollId, voterJid: voter });
        selected = (vote.selectedOptions ?? []) as Uint8Array[];
        voterJid = voter;
        break outer;
      } catch {
        // wrong jid combination (phone vs LID); try the next
      }
    }
  }
  if (!selected) {
    logger.warn({ pollId }, "couldn't decrypt poll vote");
    return;
  }
  const person = m.key.fromMe && config.wa.selfMode ? config.wa.selfName : identify(voterJid, m.pushName);
  if (!person) return;
  const picks = poll.options.map((o, i) => ({ i, h: sha256(o) })).filter(({ h }) => selected!.some((s) => Buffer.from(s).equals(h))).map(({ i }) => i);
  await onVotes(plan.id, { ...plan.votes, [person]: picks });
}

async function onMessage(m: WAMessage): Promise<void> {
  if (!isOurChat(m.key.remoteJid)) return;
  if (m.message?.pollUpdateMessage) return handlePollVote(m);
  if (m.key.fromMe && (!config.wa.selfMode || sentByBot.has(m.key.id ?? ""))) return;
  const text = textOf(m).trim();
  if (!text || text.startsWith(BOT_PREFIX.trim())) return;
  const person = m.key.fromMe ? config.wa.selfName : (identify(getKeyAuthor(m.key), m.pushName, text) ?? m.pushName ?? "someone");
  logMessage(person, text, m.key.id ?? undefined);
  if (!isAddressed(m, text)) return;

  console.log(`[in] ${person}: ${text}`);
  // Visible "working on it" signal: ⏳ on their message, ✅ when answered (❌ on error).
  // Typing indicators don't show in self-chats, and fade after ~25s elsewhere.
  const react = (emoji: string) => sock?.sendMessage(chatJid(), { react: { text: emoji, key: m.key } }).catch(() => {});
  await react("⏳");
  await status("Reading your message…");
  const typing = setInterval(() => void sock?.sendPresenceUpdate("composing", chatJid()).catch(() => {}), 10_000);
  try {
    const reply = await handleMessage(person, text);
    if (reply) await say(reply);
    await react("✅");
  } catch (err) {
    console.error("agent error:", err);
    await react("❌");
    await say(`Sorry, something went wrong on my side (${(err as Error).message.slice(0, 120)}). Try again?`);
  } finally {
    clearInterval(typing);
    await clearStatus();
    void sock?.sendPresenceUpdate("paused", chatJid()).catch(() => {});
  }
}

export async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(config.dataDir, "wa-auth"));
  sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });
  sock.ev.on("creds.update", saveCreds);

  // Link with an 8-character code instead of a QR (handy when the terminal isn't on your screen):
  // WhatsApp → Linked devices → Link a device → Link with phone number instead.
  const pairingPhone = process.env.WA_PAIRING_PHONE;
  if (pairingPhone && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock!.requestPairingCode(pairingPhone.replace(/\D/g, ""));
        console.log(`\nPairing code: ${code}\nWhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead" → enter the code.\n`);
      } catch (err) {
        console.error("pairing code request failed:", (err as Error).message);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !process.env.WA_PAIRING_PHONE) {
      console.log(`Scan this QR with ${config.wa.selfMode ? "your" : "the bot's"} WhatsApp (Settings → Linked devices → Link a device):`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("WhatsApp connected as", sock?.user?.id);
      const groups = await sock!.groupFetchAllParticipating();
      for (const g of Object.values(groups)) console.log(`  group: ${g.subject} → ${g.id}`);
      if (!config.wa.groupJid) console.log('Set WA_GROUP_JID to one of the ids above (or "self" for your own 1-1 chat) and restart.');
      if (config.wa.solo && !isSelfChat()) console.log("Solo test mode: every message in the chat is for the bot; only your vote counts.");
      if (isSelfChat()) console.log(`Self-chat mode: talk to the bot in WhatsApp's "Message yourself" chat (${chatJid()}).`);
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("WhatsApp logged out; delete data/wa-auth and re-pair.");
        return;
      }
      setTimeout(() => void startWhatsApp(), 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) await onMessage(m).catch((err) => console.error("message handling failed:", err));
  });

  setSender({
    async text(text) {
      if (!sock || !config.wa.groupJid) return console.log(`[group] ${text}`), undefined;
      const sent = await sock.sendMessage(chatJid(), { text: config.wa.selfMode ? BOT_PREFIX + text : text });
      rememberSent(sent?.key.id);
      if (sent?.key.id) sentKeys.set(sent.key.id, sent.key);
      return sent?.key.id ?? undefined;
    },
    async edit(id, text) {
      const key = sentKeys.get(id);
      if (!sock || !key) return;
      await sock.sendMessage(chatJid(), { text: config.wa.selfMode ? BOT_PREFIX + text : text, edit: key });
    },
    async remove(id) {
      const key = sentKeys.get(id);
      if (!sock || !key) return;
      await sock.sendMessage(chatJid(), { delete: key });
      sentKeys.delete(id);
    },
    async poll(question, options) {
      if (!sock || !config.wa.groupJid) return undefined;
      const name = config.wa.selfMode ? BOT_PREFIX + question : question;
      const sent = await sock.sendMessage(chatJid(), { poll: { name, values: options, selectableCount: 1 } });
      rememberSent(sent?.key.id);
      const secret = sent?.message?.messageContextInfo?.messageSecret;
      if (sent?.key.id && secret) {
        const stored: StoredPoll = { secret: Buffer.from(secret).toString("base64"), options, creatorJids: botJids() };
        kvSet(`poll:${sent.key.id}`, stored);
      }
      return sent?.key.id ?? undefined;
    },
  });
}
