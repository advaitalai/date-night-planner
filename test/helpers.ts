import { openDb, setDb } from "../src/db";
import type { Place } from "../src/types";

export function freshDb(): void {
  setDb(openDb(":memory:"));
}

let nextId = 1000;

export function place(overrides: Partial<Place> = {}): Place {
  return {
    id: nextId++,
    google_place_id: null,
    cid: null,
    name: "Test Place",
    address: null,
    lat: 35.625,
    lng: 139.72,
    primary_type: "restaurant",
    types: ["restaurant"],
    cuisine: null,
    price_level: 2,
    rating: 4.2,
    rating_count: 100,
    tabelog_score: null,
    phone: null,
    website: null,
    maps_url: null,
    opening_periods: null,
    reservable: true,
    booking_channel: "tablecheck",
    tablecheck_slug: "test",
    tabelog_url: null,
    booking_email: null,
    booking_url: null,
    profile: null,
    source: "takeout:test",
    saved_by: ["Advait"],
    note: null,
    details_fetched_at: null,
    ...overrides,
  };
}
