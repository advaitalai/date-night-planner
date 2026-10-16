# QA map: requirements vs tests

Where each requirement is tested, and where it isn't. Updated after the 12–15 Oct live week (retro). Use it to decide what to test before shipping a change.

**Columns**
- **Unit:** `npm test` (fast, no network, no AI).
- **P0:** `npm run p0`, the real bot end to end with fake WhatsApp and calls (`docs/P0_TESTS.md`).
- **Live:** seen working in real use.
- **Escaped:** bugs that reached Advait anyway.

## Chat (WhatsApp)

| Req | What | Unit | P0 | Live | Escaped (12–15 Oct) |
|---|---|---|---|---|---|
| R1/R2 | Bot in the group, messages reach it | ⛔ none | ⛔ (WhatsApp faked) | ✅ after fixes | Bad MAC, outdated WA version, synced messages skipped, 146 reconnects, crash on timeout |
| R2 | Emily recognised as Emily | ✅ number formats | ⛔ | ✅ 12 Oct | |
| R23 | Cards, house style, no em dashes | ✅ | ✅ P0-1 | ✅ | |
| R24 | Status line, ⏳/✅ | ⛔ | ⛔ | ✅ | |
| R25 | Words or a number; no polls | ✅ | ✅ | ✅ | |
| hyg | One reply per message; nothing swallowed | ⛔ | partial | ❌ "Cancel!" got no reply | cancel result never posted |
| hyg | Chit-chat ignored ("babe do you like any of these") | ⛔ | ⛔ | ✅ 12 Oct | |

## Recommendations

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| R8 | Cuisine rotation | ✅ | ⛔ | ⛔ | |
| R9 | Pick first, then book | ✅ | ✅ P0-2 | ✅ | |
| R10/R11 | Beyond the lists; what + why | ✅ | ✅ P0-1 | ✅ | |
| R11a | Area, train/walk, why rules | ✅ | ✅ P0-1 | ✅ ("Higashigotanda, 13 min walk") | |
| R12 | Open then, distance, budget, dinner only, must-haves, no repeats | ✅ | ✅ P0-1/6 | ✅ | **Temporarily closed place offered** (Thailand kitchen) |
| R12a | Honest about misses | ✅ | ✅ P0-6 | ✅ | |
| R13 | Widen before giving up | ✅ | ⛔ | ✅ | |

## Booking

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| R13a | Seats only | ✅ | ✅ (TableCheck dry run) | ✅ | |
| R14/R15 | Booking order, only the chosen place | ✅ | ✅ P0-2/3 | ✅ | |
| R15a | No call without "call" | ✅ | ✅ P0-5 | ✅ (asked for "call") | **A dropped call still ran**; **rescheduled call silently dropped, old time called** |
| R15b | Call outcome tree | ✅ | partial (booked) | ✅ no answer, unclear, booked, cancelled | |
| R15c | Time window | ✅ | ✅ P0-4 | ⛔ | |
| R15d | Call script (Emily, date check, no policy question) | ✅ | ⛔ | ✅ booked + cancelled in Japanese | |
| R17 | Phone bookings | ✅ | ✅ (fake call) | ✅ real booking and cancel | |
| R18 | Cancellation policy + "still on?" | ✅ | ⛔ | ✅ 24h reminder fired | |
| R19 | Never fail silently | partial | partial | ❌ | swallowed cancel reply; crash took the bot offline |
| R20 | Dry run | ✅ | ✅ | ✅ | |
| R21 | Day-of reminder | ⛔ | ⛔ | ✅ fired | **Sent twice** (retry after a send timeout); sent for a booking being cancelled |
| R22 | Visit logged after the date | ⛔ | ⛔ | ⛔ | |
| F1 | Change a booking | ⛔ | ⛔ | ⛔ | |
| F2 | Cancel (phone / TableCheck / "I did it myself") | partial | ⛔ | ✅ phone | swallowed reply |
| I1/I3 | Call log, "recap this call" | ✅ | ⛔ | ❌ said it couldn't see transcripts (fixed after) | |

## Weekly rhythm

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| C1 | Saturday options, Sunday nudge/decide | ✅ scheduling | ⛔ | ✅ 10 Oct (with old poll wording) | stale reminders fired after downtime (fixed earlier) |
| G1 | Skip a week | ⛔ | ⛔ | ✅ | a test skip leaked into real use (fresh-start) |

## Why bugs escaped

1. **WhatsApp itself isn't tested anywhere.** P0 fakes it. Every outage this week was in that layer.
2. **Time-based flows** (scheduled calls, reminders, retries) only ran for real. P0 has no fake clock, so "schedule, change your mind, wait" was never exercised.
3. **Multi-step conversations** (ask → change → drop) weren't P0 cases; each P0 is one or two messages.
4. **Bot claims weren't checked against what happened** ("I've dropped the call" while a job was still queued).

## Regression cases to add to P0 (from this week)

- P0-11 Schedule a call, then "don't call" → no call at the time; bot says it's dropped only if it is.
- P0-12 Schedule a call, change the time/slot ("19:15 instead"), same call time → exactly one call, with the new slot.
- P0-13 "Cancel the X booking" (phone) → the "Shall I call to cancel?" question is posted.
- P0-14 Booking exists for a date → a scheduled booking call for that date asks instead of calling.
- P0-15 Day-of reminder whose send times out → sent once, not retried.
- P0-16 Google says CLOSED_TEMPORARILY → never offered.
- P0-17 Fake clock: kickoff → nudge → decide → still-on → day-of → visit log, each fires once.
- P0-18 Two copies started → the second refuses to run.
- WhatsApp layer (needs a recorded-event harness): undecryptable message → `[skip]` line; synced "append" message within 10 min → answered once.
