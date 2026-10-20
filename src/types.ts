/** Google Places (New) regularOpeningHours period. day: 0 = Sunday. */
export interface OpeningPeriod {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
}

export type BookingChannel =
  | "tablecheck"
  | "tabelog"
  | "email"
  | "other_online"
  | "phone"
  | "walkin"
  | "not_restaurant"
  | "unknown";

/** Channels the bot can complete a booking on by itself. */
export const SELF_BOOKABLE: BookingChannel[] = ["tablecheck"];

export interface PlaceProfile {
  cuisine: string;
  vibeTags: string[];
  signatureDishes: string[];
  highlights: string[];
  priceBand: "cheap" | "mid" | "upscale" | "fine";
  summary: string;
}

/**
 * Google's place attributes (Places API "atmosphere" fields). Missing = unknown.
 * Used as hard filters ("live music") and to drop places that don't do dinner.
 */
export interface PlaceFeatures {
  liveMusic?: boolean;
  servesDinner?: boolean;
  outdoorSeating?: boolean;
  servesCocktails?: boolean;
  servesWine?: boolean;
  servesVegetarianFood?: boolean;
  /** Google's business status when it isn't OPERATIONAL, e.g. CLOSED_TEMPORARILY. */
  notOperating?: string;
}

export interface Place {
  id: number;
  google_place_id: string | null;
  cid: string | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  primary_type: string | null;
  types: string[];
  cuisine: string | null;
  price_level: number | null;
  rating: number | null;
  rating_count: number | null;
  tabelog_score: number | null;
  phone: string | null;
  website: string | null;
  maps_url: string | null;
  opening_periods: OpeningPeriod[] | null;
  reservable: boolean | null;
  booking_channel: BookingChannel;
  tablecheck_slug: string | null;
  tabelog_url: string | null;
  booking_email: string | null;
  booking_url: string | null;
  profile: PlaceProfile | null;
  source: string;
  saved_by: string[];
  note: string | null;
  details_fetched_at: string | null;
  features: PlaceFeatures | null;
}

export type ReservationStatus = "requested" | "confirmed" | "cancelled" | "failed" | "done";

export interface Reservation {
  id: number;
  plan_id: number | null;
  place_id: number;
  channel: BookingChannel;
  status: ReservationStatus;
  date: string; // YYYY-MM-DD (JST)
  time: string; // HH:mm (JST)
  party_size: number;
  external_ref: string | null;
  manage_url: string | null;
  gmail_thread_id: string | null;
  last_seen_message_id: string | null;
  policy_text: string | null;
  free_cancel_deadline: string | null; // ISO
  cancel_fee: string | null;
  notes: string | null;
  created_at?: string; // SQLite UTC "YYYY-MM-DD HH:MM:SS"
}

export type PlanStatus = "proposed" | "booking" | "booked" | "done" | "cancelled";

export interface PlanOption {
  placeId: number;
  name: string;
  availability: "available" | "unconfirmed" | "unchecked";
  /** what + why, kept for the agent's context. */
  pitch: string;
  what?: string;
  why?: string;
  score: number;
}

export interface Plan {
  id: number;
  date: string;
  time: string;
  party_size: number;
  status: PlanStatus;
  request: string | null;
  options: PlanOption[];
  poll_msg_id: string | null;
  votes: Record<string, number[]>; // person -> option indexes
  chosen_place_id: number | null;
  /** Latest acceptable time for this date night (HH:mm), when they gave a range. */
  time_latest: string | null;
}

export interface Anchor {
  label: string;
  address: string;
  lat: number;
  lng: number;
}

export interface Prefs {
  anchors: Record<string, Anchor>;
  defaultWeekday: number; // luxon: 1 = Monday ... 7 = Sunday
  defaultTime: string;
  partySize: number;
  maxTravelMin: number;
  cuisineCooldownDates: number;
  revisitCooldownWeeks: number;
  budgetPerPersonMaxJpy: number | null;
  dietary: string;
  /** Minutes after the asked time the bot may accept without checking (e.g. 18:30 → up to 19:00). */
  flexLaterMin: number;
}
