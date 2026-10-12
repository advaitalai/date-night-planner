/**
 * The chat message being handled right now, so tools can check hard rules
 * against what was actually typed (not the model's reading of it).
 */
let current: { sender: string; text: string } | null = null;

export function setCurrentMessage(m: { sender: string; text: string } | null): void {
  current = m;
}

export function currentMessage(): { sender: string; text: string } | null {
  return current;
}

/**
 * A phone call needs the word "call" (or 電話 / かけて) in the message itself.
 * "yes", "ok" or "sounds good" never place a call, whoever they were meant for.
 */
export function saysCall(text: string | undefined): boolean {
  return /\b(call|ring)\b|電話して|電話を|かけて/i.test(text ?? "");
}
