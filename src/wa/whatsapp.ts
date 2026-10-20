import makeWASocket, {
  DisconnectReason,
  getKeyAuthor,
  fetchLatestWaWebVersion,
  normalizeMessageContent,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { handleMessage } from "../agent/loop";
import { config, isSelfChat, isSolo, PEOPLE, waDigits } from "../config";
import { getUser, logMessage, upsertUser, userByJid } from "../db/repo";
import { clearStatus, saidCount, say, setSender, status } from "../notify";

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
 * replied to inline, called by name ("planner" or WA_BOT_NAME), or (bot-number mode) @-mentioned.
 * Everything else is the two of them talking: the bot reads it as context and
 * speaks up only to confirm a decision on open options.
 */

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? "fatal" });

/**
 * The Signal library prints a stack trace for every message it can't decrypt,
 * mostly backlog from other chats after a restart. It isn't actionable, so
 * hide it unless WA_LOG_LEVEL is set for debugging.
 */
const SIGNAL_NOISE = /^(Session error|Failed to decrypt message with any known session|Closing (open )?session|Removing old closed session|Decrypted message with closed session|Session already)/;
if (!process.env.WA_LOG_LEVEL) {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (typeof args[0] === "string" && SIGNAL_NOISE.test(args[0])) return;
      original(...args);
    };
  }
}

let sock: WASocket | undefined;

const BOT_PREFIX = "🤖 ";
/** Message ids already handled, so a message delivered twice (notify + sync) is answered once. */
const seenIds = new Set<string>();
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

/**
 * Map a sender to Advait/Emily: known jid, phone number (the jid or, for LID
 * senders, WhatsApp's participantPn), push name, or "I'm <name>". In the
 * couple's group anyone who isn't Advait is Emily.
 */
function identify(jid: string, pushName?: string | null, text?: string, altJid?: string | null): string | null {
  const known = userByJid(jid);
  if (known) return known.name;
  const numbers = [jid, altJid].filter((j): j is string => !!j).map((j) => j.split("@")[0].split(":")[0]);
  let name = PEOPLE.find((p) => config.wa.phones[p] && numbers.includes(waDigits(config.wa.phones[p]))) ?? null;
  name ??= PEOPLE.find((p) => pushName?.toLowerCase().includes(p.toLowerCase())) ?? null;
  const claim = text?.match(/\bi['’]?m (advait|emily)\b/i)?.[1];
  if (claim) name = PEOPLE.find((p) => p.toLowerCase() === claim.toLowerCase()) ?? name;
  // Two people in the group. Self mode: Advait's own messages are handled before this, so anyone
  // else is Emily. Own number: once one of them is known, the other unknown sender is the other one
  // (WhatsApp sometimes hides the phone number, so matching by number alone isn't enough).
  if (!name && !isSelfChat() && !config.wa.solo) {
    if (config.wa.selfMode) name = PEOPLE.find((p) => p !== config.wa.selfName) ?? null;
    else {
      const known = PEOPLE.filter((p) => getUser(p)?.wa_jid);
      if (known.length === 1) name = PEOPLE.find((p) => p !== known[0]) ?? null;
    }
    if (name) console.log(`[who] treating ${jid} (${pushName ?? "no name"}) as ${name}`);
  }
  if (name && !getUser(name)?.wa_jid) upsertUser(name, { wa_jid: jid });
  return name;
}

/** The message body, unwrapped (disappearing-message, view-once and edit wrappers). */
function contentOf(m: WAMessage) {
  return normalizeMessageContent(m.message);
}

function textOf(m: WAMessage): string {
  const msg = contentOf(m);
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

/** Whether a quoted message is one of the bot's (🤖 prefix, or sent this run). */
function quotesBot(ctx: { stanzaId?: string | null; participant?: string | null; quotedMessage?: WAMessage["message"] } | null | undefined): boolean {
  if (!ctx?.stanzaId) return false;
  if (sentByBot.has(ctx.stanzaId)) return true;
  // With its own number, anything the bot's account wrote is the bot's.
  if (!config.wa.selfMode && ctx.participant && botJids().includes(jidNormalizedUser(ctx.participant))) return true;
  const q = ctx.quotedMessage;
  const quoted = q?.conversation ?? q?.extendedTextMessage?.text ?? "";
  return quoted.startsWith(BOT_PREFIX.trim());
}

/**
 * Whether a message is for the bot: it says its name, it's an inline reply to
 * one of the bot's messages, or (bot's own number) it @mentions the bot.
 * Anything else is the two of them talking, so a "yes" or "ok go" between them
 * can never book or call anything.
 */
/** The message calls the bot by name: "planner", or its WhatsApp name (e.g. "concierge"). */
function callsBot(text: string): boolean {
  const names = ["planner", config.wa.botName].map((n) => n.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${names.join("|")})($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function isAddressed(m: WAMessage, text: string): boolean {
  if (isSolo()) return true;
  if (callsBot(text)) return true;
  const ctx = contentOf(m)?.extendedTextMessage?.contextInfo;
  if (ctx?.stanzaId) return quotesBot(ctx);
  // In self mode a mention of the bot is a mention of Advait, so only the keyword and replies count.
  if (!config.wa.selfMode && ctx?.mentionedJid?.some((j) => botJids().includes(jidNormalizedUser(j)))) return true;
  return false;
}

async function onMessage(m: WAMessage): Promise<void> {
  if (!isOurChat(m.key.remoteJid)) return;
  if (m.key.fromMe && (!config.wa.selfMode || sentByBot.has(m.key.id ?? ""))) return;
  const text = textOf(m).trim();
  if (!text) {
    // Every message in our chat is accounted for in the log, so a silent bot can be diagnosed.
    const kinds = Object.keys(m.message ?? {}).join(",") || "none";
    if (!m.message) console.log(`[skip] a message from ${m.pushName ?? m.key.participant ?? "?"} couldn't be decrypted (WhatsApp keys); open WhatsApp on your phone and send it again`);
    else if (!/reactionMessage|protocolMessage|senderKeyDistributionMessage|messageContextInfo/.test(kinds)) console.log(`[skip] non-text message (${kinds})`);
    return;
  }
  if (text.startsWith(BOT_PREFIX.trim())) return;
  const person = m.key.fromMe ? config.wa.selfName : (identify(getKeyAuthor(m.key), m.pushName, text, (m.key as { participantPn?: string }).participantPn) ?? m.pushName ?? "someone");
  logMessage(person, text, m.key.id ?? undefined);
  if (!isAddressed(m, text)) {
    // Not for the bot: it only listens, and may ask to confirm a decision on open options.
    console.log(`[heard] ${person}: ${text.slice(0, 200)}`);
    try {
      const reply = await handleMessage(person, text, { addressed: false });
      if (reply) await say(reply);
    } catch (err) {
      console.error("agent error (listening):", err);
    }
    return;
  }

  console.log(`[in] ${person}: ${text}`);
  // Visible "working on it" signal: ⏳ on their message, ✅ when answered (❌ on error).
  // Typing indicators don't show in self-chats, and fade after ~25s elsewhere.
  const react = (emoji: string) => sock?.sendMessage(chatJid(), { react: { text: emoji, key: m.key } }).catch(() => {});
  await react("⏳");
  await status("Reading your message…");
  const typing = setInterval(() => void sock?.sendPresenceUpdate("composing", chatJid()).catch(() => {}), 10_000);
  const before = saidCount();
  try {
    const reply = await handleMessage(person, text);
    if (reply) await say(reply);
    // Nothing to say (e.g. "thanks"): take the ⏳ back off, no ✅.
    await react(saidCount() > before ? "✅" : "");
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
  // Announce the current WhatsApp Web version: with the library's built-in (older) one,
  // WhatsApp can keep the connection open but stop delivering messages.
  const latest = await fetchLatestWaWebVersion({}).catch(() => null);
  if (latest?.version) console.log(`WhatsApp Web version ${latest.version.join(".")}`);
  sock = makeWASocket({
    ...(latest?.version ? { version: latest.version } : {}),
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
      // A slow WhatsApp reply here used to crash the whole app (Timed Out); listening works without it.
      const groups = await sock!.groupFetchAllParticipating().catch((err: Error) => {
        console.warn(`couldn't list groups (${err.message}); still listening in ${config.wa.groupJid}`);
        return {} as Record<string, { id: string; subject: string }>;
      });
      if (!config.wa.groupJid) {
        for (const g of Object.values(groups)) console.log(`  group: ${g.subject} → ${g.id}`);
        console.log('Set WA_GROUP_JID to one of the ids above (or "self" for your own 1-1 chat) and restart.');
      } else if (!isSelfChat()) {
        const g = groups[config.wa.groupJid];
        console.log(g ? `Listening in "${g.subject}".` : Object.keys(groups).length ? `⚠️ Not a member of WA_GROUP_JID ${config.wa.groupJid}. Unset it to list your groups.` : `Listening in ${config.wa.groupJid}.`);
      }
      if (config.wa.solo && !isSelfChat()) console.log("Solo test mode: every message in the chat is for the bot; only your vote counts.\nReady. Say hello in WhatsApp.");
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
    // After a reconnect WhatsApp can deliver brand-new messages as a sync ("append"), not "notify".
    // Handle the recent ones (last 10 min) once each; skip genuinely old history.
    const fresh = (m: WAMessage) => Date.now() / 1000 - Number(m.messageTimestamp ?? 0) < 10 * 60;
    const ours = messages.filter((m) => isOurChat(m.key.remoteJid));
    if (ours.length) console.log(`[wa] ${ours.length} message(s) in our group (${type})`);
    const todo = type === "notify" ? messages : ours.filter(fresh);
    // "notify" messages are all handled; only a sync ("append") can leave older ones out.
    const old = type === "notify" ? 0 : ours.length - todo.length;
    if (old) console.log(`[skip] ${old} older message(s) from our chat synced from the phone (not new)`);
    for (const m of todo) {
      if (m.key.id && seenIds.has(m.key.id)) continue;
      if (m.key.id) seenIds.add(m.key.id);
      if (seenIds.size > 1000) seenIds.delete(seenIds.values().next().value!);
      await onMessage(m).catch((err) => console.error("message handling failed:", err));
    }
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
  });
}
