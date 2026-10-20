import { logMessage } from "./db/repo";

/**
 * Outbound messages to the chat. The WhatsApp module registers the real
 * sender at startup; until then (and in tests/scripts) messages go to stdout.
 */

type Sender = {
  text(text: string): Promise<string | undefined>;
  /** Replace the text of a message the bot sent earlier. */
  edit(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
};

let sender: Sender = {
  async text(text) {
    console.log(`[chat] ${text}`);
    return undefined;
  },
  async edit(_id, text) {
    console.log(`[chat edit] ${text}`);
  },
  async remove() {},
};

export function setSender(s: Sender): void {
  sender = s;
}

/** House style: no em dashes in anything the bot sends. */
export function tidy(text: string): string {
  return text.replace(/\s*—\s*/g, ", ").replace(/ – /g, ", ");
}

let said = 0;
/** How many messages the bot has posted (to tell chit-chat it ignored from real answers). */
export function saidCount(): number {
  return said;
}

export async function say(text: string): Promise<string | undefined> {
  said++;
  text = tidy(text);
  logMessage("planner", text);
  console.log(`[out] ${text}`);
  return sender.text(text);
}

// ---------- live status line ----------
//
// One small message ("⏳ Checking live availability at 8 places…") that is
// edited as work progresses and removed when the answer is posted, so the
// chat shows what the bot is doing without filling up with noise.

let statusId: string | undefined;
let statusText = "";
let statusAt = 0;
/** Never edit a status line older than this: it has scrolled out of sight (and WhatsApp limits edits). */
const STATUS_FRESH_MS = 3 * 60_000;

export async function status(text: string): Promise<void> {
  const line = `⏳ ${text}`;
  if (line === statusText) return;
  statusText = line;
  console.log(`[status] ${text}`);
  try {
    if (statusId && Date.now() - statusAt > STATUS_FRESH_MS) {
      const old = statusId;
      statusId = undefined;
      await sender.remove(old).catch(() => {});
    }
    if (statusId) await sender.edit(statusId, line);
    else {
      statusId = await sender.text(line);
      statusAt = Date.now();
    }
  } catch {
    // Status lines are best-effort.
  }
}

export async function clearStatus(): Promise<void> {
  const id = statusId;
  statusId = undefined;
  statusText = "";
  if (id) await sender.remove(id).catch(() => {});
}
