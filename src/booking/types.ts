import type { Contact } from "../config";
import type { BookingChannel, Place, Reservation } from "../types";

export interface Slot {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm, the time to ask for
  partySize: number;
  /** Latest acceptable time (HH:mm) the bot may take without asking. Default: time + prefs.flexLaterMin. */
  latest?: string;
  /** The originally asked time, when the booking moved to another time inside the window. */
  asked?: string;
}

export interface AvailabilityResult {
  status: "available" | "unavailable" | "unknown";
  /** Nearby free times on the same date (HH:mm), when the platform exposes them. */
  alternatives?: string[];
  detail?: string;
  /** Why a place can't be booked by the bot even if a table is free. */
  blocker?: "unsupported_flow" | "courses_only";
}

export interface BookResult {
  status: "confirmed" | "requested" | "failed";
  externalRef?: string;
  manageUrl?: string;
  gmailThreadId?: string;
  policyText?: string;
  /** The requested time is definitely full (don't try other channels). */
  full?: boolean;
  /** Other times the venue offered (HH:mm). */
  alternatives?: string[];
  detail?: string;
}

export interface ChangeResult {
  ok: boolean;
  detail?: string;
}

export interface BookingAdapter {
  channel: BookingChannel;
  checkAvailability(place: Place, slot: Slot): Promise<AvailabilityResult>;
  book(place: Place, slot: Slot, contact: Contact, notes?: string): Promise<BookResult>;
  modify(reservation: Reservation, place: Place, slot: Slot, contact: Contact): Promise<ChangeResult>;
  cancel(reservation: Reservation, place: Place, contact: Contact): Promise<ChangeResult>;
}

export class BookingError extends Error {}
