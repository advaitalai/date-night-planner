# Product backlog

Simplified and prioritised 22 Oct; updated 2 Nov from the first two weeks of live use. Older triage tables (dialer and recommender QA, all but two items done) are in git history.

**Lean rule (16 Oct, Advait):** the product stays small so it doesn't need constant testing. Before adding anything, ask:
- Is it worth testing for as long as it exists?
- Could the agent's judgement do it instead of new code?

**How items move up:** real use. Each item says what would show it's needed.

## P1: next (evidence from 23 Oct–2 Nov)

1. **Fresh opening hours, including special and holiday days.** Impact high, effort M.
   - 1 Nov: Pulcino looked closed until Tuesday (regular weekly hours only); Google Maps showed it open until 8pm. Emily needed four messages to get a call.
   - Use Google's current hours for today and the next few days, regular hours as the fallback; refresh only the picks or a named place; ask once "closed per Google, call anyway?".
   - Risky (hours decide picks and calls): ship on its own, with Kimmy (must not call) and Pulcino (must call) as tests.
2. **Calls can press phone-menu keys.** Impact high, effort S.
   - 23 Oct: cado's line answered "press 1, 2 or 3"; the bot said 2番 aloud until it hung up.
3. **Decide TableCheck's newer booking pages.** Impact high, effort M (C).
   - 6 of 15 TableCheck places on Advait's list use them; they fall back to a call.
   - First real case, cado: the call hit a phone menu; Muse booked it online. This points to **C, computer use**, after giving calls a fair try with 2.
   - Options: **A.** script the flow (REQUIREMENTS §7), **B.** keep calling, **C.** computer use for those pages (~$0.20–1 a booking, guardrails: seats only, no card).
4. **Prove a TableCheck booking from the server.** Impact high, effort S (a test, no code).

## P2: soon

5. **Google Maps share links.** Impact medium, effort S. 1 Nov: "I can't open that Maps link"; pasting a link is the natural way to name a place.
6. **👍 / 👎 after each date.** Impact medium, effort S. The morning-after message asks "How was X?"; 👎 places aren't suggested again.
7. **TableCheck "seating only, pay optional" items** (`postpay_optional`). Impact medium, effort S. Check one by hand; allow if no card is taken.

## P3: later, only if it comes up

8. **Lunch and brunch, and a full group mode** (group-friendly picks and wording). Impact medium, effort M–L. Since 5 Nov dinners for any party size are in scope (option B); lunch and brunch stay out. Sweep below.
9. **Driving times** ("10 min drive"). Impact low, effort M. Travel is train or walk only; matters on trips outside Tokyo (Izu, 1 Nov).
10. **Watch full places for cancellations.** Impact medium, effort M.
11. **Book sought-after places weeks ahead.** Impact medium, effort S–M.
12. **Calendar invites.** Impact low, effort S.
13. **A "midway" starting point.** Impact low, effort S.

## Watch, don't build

- **Places API cost.** Check the Cloud console bill in early November.
- **WhatsApp ban risk.** Unofficial library on its own number; move to Meta's official API if group support arrives.
- **Call transcripts.** Deepgram nova-3 since 2 Nov; it sometimes drops a syllable (満 from 満席). Revisit only if it changes an outcome.

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
