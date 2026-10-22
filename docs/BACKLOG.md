# Product backlog

Simplified and prioritised 22 Oct. Older triage tables (dialer and recommender QA, all but two items done) are in git history.

**Lean rule (16 Oct, Advait):** the product stays small so it doesn't need constant testing. Before adding anything, ask:
- Is it worth testing for as long as it exists?
- Could the agent's judgement do it instead of new code?

**How items move up:** real use. Each item says what would show it's needed.

## P1: this week (decide from live use)

1. **Prove a TableCheck booking from the server.**
   - Still unverified live; the Kimmy booking was a call.
   - Needed for: everything below on TableCheck.
2. **Decide TableCheck's newer booking pages** (due ~28 Oct).
   - 6 of 15 TableCheck places on Advait's list use them (Kiito, Kimmy, Kuss, Picica Picica, BROWNSTONE, Peter Luger…). Today they fall back to a phone call.
   - **A.** Script the newer flow (steps in REQUIREMENTS §7). Breaks when TableCheck changes the page.
   - **B.** Keep calling them. Nothing to build.
   - **C.** Claude computer use for those pages only. Adapts to changes; ~$0.20–1 a booking; needs guardrails (seats only, no card, stop before anything unexpected).
   - **Recommendation: B**, unless calls to these places fail or annoy staff. Then **C**, not A.
   - Signal: count how many bookings became calls because of it, and how those calls went.

## P2: next

3. **👍 / 👎 after each date.**
   - The morning-after visit log asks "How was X?" and stores the answer.
   - 👎 places aren't suggested again; 👍 ones lift similar places.
   - The only item that makes picks better over time. Small: one message, one column.
4. **Fresh opening hours.**
   - Hours come from Google once and are never refreshed; holidays are ignored.
   - Refresh when older than 30 days; use Google's holiday hours.
   - Signal: a booking or call at a place that turned out closed.
5. **TableCheck "seating only, pay optional" items** (`postpay_optional`).
   - The bot skips them as "needs a card". Check one by hand (The Public Place); allow them if no card is taken.
   - Small. More places bookable online, fewer calls.

## P3: later, only if it comes up

6. **Lunch, brunch, friends, family.** Out of scope since 22 Oct. Options and the 14-point sweep are below.
   - Signal: they ask for it more than a couple of times.
7. **Watch full places for cancellations,** and book when a table frees up.
   - Signal: a place they both want keeps coming back full.
8. **Book sought-after places weeks ahead.**
   - Signal: same as 7.
9. **Calendar invites** for both when a booking is confirmed, updated on change or cancel.
   - Signal: they forget a booking despite the day-of reminder.
10. **A "midway" starting point** (between home and the office, or two places they'll be that day).

## Watch, don't build

- **Places API cost.** Searches include atmosphere attributes (pricier tier). Check the Cloud console bill in early November.
- **WhatsApp ban risk.** The bot uses an unofficial library on its own number. Move to Meta's official API if group support becomes generally available.

## Not doing (cut, with the reason)

- **Email booking** (cut 16 Oct). Tokyo restaurants book by TableCheck, other sites or phone; email-only places are rare, and replies need a Gmail watcher. Revisit only if a place they want takes email only.
- **More booking sites** (Hot Pepper, OMAKASE, ebica, Toreta, Ikyu, Tabelog). The phone call covers them.
- **Live help mid-call** ("they offer 19:00, OK?"). The call already reports offered times and the bot calls back.
- **Learning vibes from chat, weather-aware picks, non-dinner date ideas, an admin page, "already visited" from Timeline.** Nice, but each adds rules to test.
- From 16 and 20 Oct: scheduled calls, vote counting and the Sunday auto-book, the Saturday trigger and Sunday reminder, "skip a week", saving Maps links from chat, Drive pickup and the onboarding page, WhatsApp polls, auto-cancel and the 48h "still on?", the detailed call outcome tree.

## Reference: lunch and group meals scope (swept 22 Oct)

| # | Area | Today | Change needed |
|---|---|---|---|
| 1 | Request parsing (`parseRequest.ts`) | "lunch" isn't a time | Meal → time (lunch ≈ 12:30) |
| 2 | Dinner filter (`filters.ts`) | Drops cafés and "no dinner" places | Meal-aware; Google's servesLunch |
| 3 | Import (`takeout.ts`) | 954 of Emily's places skipped | Re-import with a lunch-friendly rule |
| 4 | TableCheck menu picker | Refuses lunch items | Allow lunch seat items for lunch slots |
| 5 | Free times when full (`service.ts`) | Only 17:00–21:30 | Window around the meal |
| 6 | Plans per date (`repo.ts`) | One plan per date | Key by date + meal |
| 7 | Day-of reminder | 11:00, "Tonight 🥂" | Time and wording by meal |
| 8 | Budget | Dinner prices | Lunch budget |
| 9–12 | Bot instructions, listener, tools, pitches, cards, discovery | "Date night for a couple" | Wording by occasion and party |
| 13 | Rotation and visit log | Every booking is a date | Only date nights count |
| 14 | Japanese call script | 12:30 as 午後12時半 | 午後0時半 |

- **B. Lunch-lite:** 1, 4, 5, 7 only. Plan and book a lunch with date wording.
- **C. Full:** all 14, a second product mode. ~10 files, a re-import, new tests.

## Done (MVP, live since 20 Oct)

- WhatsApp group bot on its own number ("Concierge"). Answers replies, its name and @mentions; listens to the rest; either of you can decide.
- Saved lists from a Takeout CSV import (both lists in).
- Recommender: free-text requests, home or office start, cuisine rotation, "like X", discovery beyond the lists, availability checked first, pitches from stored facts only.
- Booking on TableCheck, else an AI call in Japanese: book, change, cancel. Cancellation policy turned into a deadline.
- Reminders: one "still on?" a day before free cancellation ends, the day-of reminder, the visit log.
- Runs on a Google Cloud VM; logs readable by Claude.
