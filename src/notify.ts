import { logMessage } from "./db/repo";

/**
 * Outbound messages to the chat. The WhatsApp module registers the real
 * sender at startup; until then (and in tests/scripts) messages go to stdout.
 */

type Sender = {
  text(text: string): Promise<string | undefined>;
  poll(question: string, options: string[]): Promise<string | undefined>;
  /** Replace the text of a message the bot sent earlier. */
  edit(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
};

let sender: Sender = {
  async text(text) {
    console.log(`[chat] ${text}`);
    return undefined;
  },
  async poll(question, options) {
    console.log(`[chat poll] ${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`);
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

export async function say(text: string): Promise<string | undefined> {
  logMessage("planner", text);
  console.log(`[out] ${text.slice(0, 500)}`);
  return sender.text(text);
}

/** Post a single-choice poll; returns the WhatsApp message id used to match votes. */
export async function poll(question: string, options: string[]): Promise<string | undefined> {
  logMessage("planner", `[poll] ${question} — ${options.join(" | ")}`);
  return sender.poll(question, options);
}

// ---------- live status line ----------
//
// One small message ("⏳ Checking live availability at 8 places…") that is
// edited as work progresses and removed when the answer is posted, so the
// chat shows what the bot is doing without filling up with noise.

let statusId: string | undefined;
let statusText = "";

export async function status(text: string): Promise<void> {
  const line = `⏳ ${text}`;
  if (line === statusText) return;
  statusText = line;
  console.log(`[status] ${text}`);
  try {
    if (statusId) await sender.edit(statusId, line);
    else statusId = await sender.text(line);
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
