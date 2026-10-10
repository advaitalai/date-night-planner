import { logMessage } from "./db/repo";

/**
 * Outbound messages to the group. The WhatsApp module registers the real
 * sender at startup; until then (and in tests/scripts) messages go to stdout.
 */

type Sender = {
  text(text: string): Promise<string | undefined>;
  poll(question: string, options: string[]): Promise<string | undefined>;
};

let sender: Sender = {
  async text(text) {
    console.log(`[group] ${text}`);
    return undefined;
  },
  async poll(question, options) {
    console.log(`[group poll] ${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`);
    return undefined;
  },
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
