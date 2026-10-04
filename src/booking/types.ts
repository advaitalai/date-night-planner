import type { Contact } from "../config";
import type { BookingChannel, Place, Reservation } from "../types";

export interface Slot {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  partySize: number;
}

export interface AvailabilityResult {
  status: "available" | "unavailable" | "unknown";
  /** Nearby free times on the same date (HH:mm), when the platform exposes them. */
  alternatives?: string[];
  detail?: string;
}

export interface BookResult {
  status: "confirmed" | "requested" | "failed";
  externalRef?: string;
  manageUrl?: string;
  gmailThreadId?: string;
  policyText?: string;
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
