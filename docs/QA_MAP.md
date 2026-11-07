# QA map: requirements vs tests

Where each requirement is tested, and where it isn't. Updated after the 12–15 Oct live week (retro) and the 16 Oct lean cut. Use it to decide what to test before shipping a change. The plain-language version, by user story, is `docs/USER_STORIES.md`.

**Columns**
- **Unit:** `npm test` (fast, no network, no AI).
- **P0:** `npm run p0`, the real bot end to end with fake WhatsApp and calls (`docs/P0_TESTS.md`).
- **Live:** seen working in real use.
- **Escaped:** bugs that reached Advait anyway.

## Chat (WhatsApp)

| Req | What | Unit | P0 | Live | Escaped (12–15 Oct) |
|---|---|---|---|---|---|
| R1/R2 | Bot in the group, messages reach it | No | No (WhatsApp faked) | Yes after fixes | Bad MAC, outdated WA version, synced messages skipped, 146 reconnects, crash on timeout |
| R2 | Emily recognised as Emily | Yes number formats | No | Yes 12 Oct | |
| R23 | Cards, house style, no em dashes | Yes | Yes P0-1 | Yes | |
| R24 | Status line (hourglass, then tick) | No | No | Yes | |
| R25 | Words or a number; no polls | Yes | Yes | Yes | |
| R2 | Answers only inline replies and "planner"; listens to the rest (16 Oct) | Yes | Yes P0-7 | Not yet | |
| R3 | Either of them decides; confirms a decision it heard (16 Oct) | Yes (confirm) | Yes P0-7 | Not yet | |
| hyg | Every request answered; nothing swallowed | No | partial | Broke: "Cancel!" got no reply | cancel result never posted |

## Recommendations

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| R8 | Cuisine rotation | Yes | No | No | |
| R9 | Pick first, then book | Yes | Yes P0-2 | Yes | |
| R10/R11 | Beyond the lists; what + why | Yes | Yes P0-1 | Yes | |
| R11a | Area, train/walk, why rules | Yes | Yes P0-1 | Yes ("Higashigotanda, 13 min walk") | |
| R12 | Open then, distance, budget, dinner only, must-haves, no repeats | Yes | Yes P0-1/6 | Yes | **Temporarily closed place offered** (Thailand kitchen) |
| R12a | Honest about misses | Yes | Yes P0-6 | Yes | |
| R13 | Widen before giving up | Yes | No | Yes | |

## Booking

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| R13a | Seats only | Yes | Yes (TableCheck dry run) | Yes | |
| R14/R15 | Booking order, only the chosen place | Yes | Yes P0-2/3 | Yes | |
| R15a | Calls only with a go-ahead (deciding = go-ahead; otherwise ask; closed → wait) | Yes | Yes P0-5 | Changed 16 Oct | Old rule: a dropped call still ran; a rescheduled call called the old time. Both came from scheduled calls, now removed. |
| R15b | After a call: what happened, summary, offered times | Yes | partial (booked, cancelled) | Yes (older messages) | |
| R15c | Time window | Yes | Yes P0-4 | No | |
| R15d | Call script (Emily, date check, no policy question) | Yes | No | Yes booked + cancelled in Japanese | |
| R17 | Phone bookings | Yes | Yes (fake call) | Yes real booking and cancel | |
| R18 | Cancellation policy + one "still on?" | Yes | No | Yes, 24h reminder fired | |
| R19 | Never fail silently | partial | partial | Broke: | swallowed cancel reply; crash took the bot offline |
| R20 | Dry run | Yes | Yes | Yes | |
| R21 | Day-of reminder | No | No | Yes fired | **Sent twice** (retry after a send timeout); sent for a booking being cancelled |
| R22 | Visit logged after the date | No | No | No | |
| F1 | Change a booking | No | No | No | |
| F2 | Cancel (phone / TableCheck / "I did it myself") | partial | No | Yes phone | swallowed reply |
| I1 | Call log with transcripts ("recap in chat" cut 16 Oct) | Yes | No | Yes | |

## Weekly rhythm

| Req | What | Unit | P0 | Live | Escaped |
|---|---|---|---|---|---|
| C1 | Saturday options, Sunday reminder (no auto-book since 16 Oct) | Yes scheduling | No | Yes 10 Oct (with old poll wording) | stale reminders fired after downtime (fixed earlier) |
| G1 | Skip a week | No | No | Yes | a test skip leaked into real use (fresh-start) |

## Why bugs escaped

1. **WhatsApp itself isn't tested anywhere.** P0 fakes it. Every outage this week was in that layer.
2. **Time-based flows** (scheduled calls, reminders, retries) only ran for real. P0 has no fake clock, so "schedule, change your mind, wait" was never exercised.
3. **Multi-step conversations** (ask → change → drop) weren't P0 cases; each P0 is one or two messages.
4. **Bot claims weren't checked against what happened** ("I've dropped the call" while a job was still queued).

## Regression cases to add to P0 (from this week)

- ~~P0-11, P0-12, P0-14~~ (scheduled calls): not needed, scheduled calls were cut on 16 Oct.
- P0-13 "Cancel the X booking" (phone) → the "Shall I call to cancel?" question is posted. **Done 16 Oct, inside P0-5.**
- P0-15 Day-of reminder whose send times out → sent once, not retried.
- P0-16 Google says CLOSED_TEMPORARILY → never offered.
- P0-17 Fake clock: kickoff → nudge → still-on → day-of → visit log, each fires once.
- P0-18 Two copies started → the second refuses to run.
- WhatsApp layer (needs a recorded-event harness): undecryptable message → `[skip]` line; synced "append" message within 10 min → answered once.
