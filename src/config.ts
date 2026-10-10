import "dotenv/config";
import path from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  anthropicModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  timezone: "Asia/Tokyo",

  wa: {
    groupJid: env("WA_GROUP_JID"),
    /**
     * Run on Advait's own WhatsApp as a linked device instead of a separate
     * number. Bot messages then come from Advait, prefixed with 🤖.
     */
    selfMode: env("WA_SELF_MODE", "1") === "1",
    selfName: "Advait",
    /** Solo test: only Advait votes and every message is for the bot (any chat, e.g. a group with just him). */
    solo: env("WA_SOLO", "0") === "1",
    phones: { Advait: env("ADVAIT_PHONE"), Emily: env("EMILY_PHONE") } as Record<string, string>,
  },

  google: {
    mapsKey: env("GOOGLE_MAPS_API_KEY"),
    clientId: env("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
  },
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8080"),
  port: Number(env("PORT", "8080")),

  booking: {
    contact: {
      name: env("BOOKING_NAME"),
      nameKana: env("BOOKING_NAME_KANA"),
      phone: env("BOOKING_PHONE"),
      email: env("BOOKING_EMAIL"),
    },
    tablecheck: { email: env("TABLECHECK_EMAIL"), password: env("TABLECHECK_PASSWORD") },
    tabelog: { email: env("TABELOG_EMAIL"), password: env("TABELOG_PASSWORD") },
  },

  dryRun: env("DRY_RUN", "1") === "1",
};

export type Contact = typeof config.booking.contact;

/** "070-1568-0178" → "+81 70-1568-0178" for English text and international forms. */
export function intlPhone(phone: string): string {
  const p = phone.trim();
  if (p.startsWith("+")) return p;
  return p.startsWith("0") ? `+81 ${p.slice(1)}` : p;
}

/** "070-1568-0178" / "+81 70 1568 0178" → domestic "070-1568-0178" for Japanese text. */
export function domesticPhone(phone: string): string {
  const p = phone.trim();
  const m = p.match(/^\+81[\s-]*0?(.*)$/);
  return m ? `0${m[1]}`.replace(/\s+/g, "-") : p;
}

/** People in the group. Names are used as identifiers everywhere (saved_by, votes). */
export const PEOPLE = ["Advait", "Emily"] as const;
export type Person = (typeof PEOPLE)[number];

/**
 * WA_GROUP_JID=self runs the bot in Advait's "Message yourself" chat: a private
 * 1-1 test channel. Only Advait votes there, and every message is for the bot.
 */
export function isSelfChat(): boolean {
  return config.wa.groupJid === "self";
}

/** Solo testing: Advait alone, either in "Message yourself" or with WA_SOLO=1. */
export function isSolo(): boolean {
  return isSelfChat() || config.wa.solo;
}

/** Who has to vote before a poll counts as agreed. */
export function voters(): readonly Person[] {
  return isSolo() ? [config.wa.selfName as Person] : PEOPLE;
}

/** Default anchors. Coordinates are approximate and refined by geocoding on first run. */
export const DEFAULT_ANCHORS = {
  home: {
    label: "home",
    address: "Residia Tower Meguro Fudomae, 3-7-6 Nishigotanda, Shinagawa, Tokyo",
    lat: 35.6227,
    lng: 139.7163,
  },
  office: {
    label: "work",
    address: "Arco Tower Annex, 1-8-1 Shimomeguro, Meguro, Tokyo",
    lat: 35.6331,
    lng: 139.7128,
  },
};
