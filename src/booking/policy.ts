import { kvGet, kvSet } from "../db";
import type { Place } from "../types";

/**
 * Cancellation policy text from the restaurant's own pages (website, Tabelog),
 * looked up before a phone call so the caller doesn't have to ask: shorter,
 * cheaper calls with less to go wrong. Returns the passages that mention
 * cancelling, for applyPolicy() to read; null if nothing was found (then the
 * usual 24h assumption applies and the chat is told).
 */
const DAYS = 30;
const WORDS = /キャンセル|取り消し|cancel/i;

export function policySnippets(html: string, max = 3): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  text.forEach((line, i) => {
    if (out.length < max && WORDS.test(line)) out.push(text.slice(i, i + 3).join(" ").slice(0, 400));
  });
  return out;
}

export async function findPolicyOnline(place: Place): Promise<string | null> {
  const key = `policy:${place.id}`;
  const cached = kvGet<{ text: string | null; at: string } | null>(key, null);
  if (cached && Date.now() - Date.parse(cached.at) < DAYS * 86_400_000) return cached.text;
  const found: string[] = [];
  for (const url of [place.tabelog_url, place.website].filter((u): u is string => !!u)) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) found.push(...policySnippets(await res.text()));
    } catch {
      // unreachable page: try the next one
    }
  }
  const text = found.length ? found.join("\n") : null;
  kvSet(key, { text, at: new Date().toISOString() });
  return text;
}
