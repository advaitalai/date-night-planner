/**
 * The chat message being handled right now (who sent it and what they typed),
 * for tools that need it.
 */
let current: { sender: string; text: string } | null = null;

export function setCurrentMessage(m: { sender: string; text: string } | null): void {
  current = m;
}

export function currentMessage(): { sender: string; text: string } | null {
  return current;
}
