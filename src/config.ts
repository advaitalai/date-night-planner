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

/** People in the group. Names are used as identifiers everywhere (saved_by, votes). */
export const PEOPLE = ["Advait", "Emily"] as const;
export type Person = (typeof PEOPLE)[number];

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
