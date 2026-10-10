# Date Night Planner: requirements

Owner: Advait. Users: Advait and Emily (a couple in Tokyo).
Status: MVP built on branch `claude/festive-volta-e3nm17` (PR #1). **First real booking made on 7 Oct 2026:** h:armonia, Fri 9 Oct 18:00, 2 people, seats only, via TableCheck. Kept (they're going). The next milestone is the WhatsApp beta (phase 3).

## 1. Problem

Planning the weekly date night means choosing a place, checking it's free, booking it, and keeping track of cancellation deadlines. Booking is the most annoying part. The goal is an agent that does all of this inside the WhatsApp chat Advait and Emily already use. The humans only vote and show up.

## 2. MVP success event

> **The bot makes a real reservation for a Wednesday date night**, one that Advait and Emily chose, and posts the confirmation with the reference number and cancellation deadline.

First target: Wed 7 Oct 2026, around 18:30, near home.

## 3. People, places, defaults

| Item | Value |
|---|---|
| Home | Residia Tower Meguro Fudomae, 3-7-6 Nishigotanda, Shinagawa (Gotanda/Fudomae) |
| Work (Advait) | Arco Tower Annex, 1-8-1 Shimomeguro, Meguro (near Meguro station) |
| Usual slot | Wednesday 18:30, 2 people. Day and time must be easy to change from chat. |
| Planning cadence | Plan the weekend before: options go out Sat 10:00, a nudge Sun 10:00, a decision by Sun 20:00. Monday is too late to get tables at good places. |
| Travel limit | About 25 min from the starting point (default: home). "Near work" switches the starting point to the office. |
| Budget | ¥15,000 per person by default (can be changed) |
| Booking contact | In `.env` only, because the repo is public. Name Advait (アドヴァイト), Japanese phone 070 number, advaitalai@gmail.com. Japanese text puts the Japanese name first. |

## 4. Functional requirements

### 4.1 Chat (WhatsApp)
- R1. The bot lives in a WhatsApp group with Advait and Emily.
- R2. No extra SIM. Self mode (default) links the bot to Advait's own WhatsApp as a linked device. Its messages are prefixed with 🤖. People address it by saying "planner" or by replying to its messages.
- R3. Options are posted as a WhatsApp poll. When both people vote for the same option, the bot books it straight away. If the vote is split, it says so. At the decide deadline it books the top-voted option (a tie goes to the higher-ranked one).
- R4. It understands loose requests: "feeling Italian, not too far from work", "somewhere like Monna Lisa", "Thursday instead", "move it to 19:30", "cancel".

### 4.2 Saved places
- R5. It uses both people's saved Google Maps places. There is no API for those lists, so they come in through Google Takeout:
  - a one-off CSV import (`fixtures/Tokyo_food.csv` is Advait's list);
  - a recurring Takeout export (*Saved* only, delivered to Drive every 2 months) that the bot picks up automatically.
- R6. A Google Maps link pasted into the chat gets added to the sender's saved places.
- R7. A place saved by both people ranks higher.

### 4.3 Recommendations
- R8. Rotate cuisines: rank cuisines from the last ~3 dates lower.
- R9. **Pick first, then book** (changed 10 Oct 2026, from Advait's beta feedback). Options are chosen for fit: open then, distance, budget, cuisine, rotation. Live availability is not checked up front; the bot books right after the choice and reports quickly if the time is full, with the alternatives.
- R10. Go beyond the saved lists. Find similar places (by cuisine, vibe and price) and new places near the starting point. Explain the link, e.g. "similar to X on Emily's list".
- R11. Each option comes with a short pitch saying why: a signature dish, the vibe ("live band"), travel time. Pitches may only use facts from stored reviews or profiles, with nothing invented.
- R12. Hard filters: open at that time, within the travel limit, bookable by the bot, not visited recently, within budget, matching any requested cuisine.
- R13. If too few places pass the filters, widen automatically (travel +10 then +20 min, budget ×1.5 then any) and say so. For a cuisine request ("anything Indian?") search beyond the saved lists before ever saying there's nothing. Explain what ruled places out only as a last resort.

### 4.4 Reservations
- R13a. **Seat-only bookings.** Never book courses or anything needing prepayment or a card. Pick TableCheck's seat-only item (e.g. "Reservation for seats only"), or skip the place. The ¥ amounts shown to users are average spend per person, not prices.
- R14. **The bot books itself.** Posting a link or phone number for a human to act on doesn't count. It also changes and cancels bookings.
- R15. Booking order, fastest and most predictable first; on failure move to the next (a definite "that time is full" stops and asks instead):
  1. **Booking sites:** TableCheck (guest booking in a headless browser), then Tabelog (saved login).
  2. **Email:** fixed polite template, Japanese first then English, from Advait's Gmail. Replies are read and classified.
  3. **AI phone call:** Vapi (Japanese speech, Claude for the conversation). Says it's an AI assistant, seats only, never agrees to a course or card, asks the cancellation policy. The transcript is read to get the outcome.
- R16. Google "Reserve a table" has no consumer API; it hands off to the booking site behind it, so the bot books there.
- R17. Any place with a phone number is bookable (via an AI call). Walk-in-only places are excluded.
- R18. Cancellation policy:
  - Read the policy from the booking page or email and work out the last moment to cancel for free (assume 24h if no policy is stated, and say so).
  - Ask "still on?" 48h before that deadline and again at 24h.
  - Cancel automatically only if someone asked to cancel, or if auto-cancel is turned on.
- R19. Never fail silently. If a booking fails (slot gone, captcha, site changed), say so in the group and try the next option.
- R20. `DRY_RUN=1` (the default) stops before the final confirm click and sends emails to Advait instead of the restaurant. Turn it off only after the booking flow has been checked live.

### 4.5 Chat UX

- R23. Messages use WhatsApp formatting: *bold* names, short lines, blank lines between items. Never em dashes.
- R24. Show what the bot is doing: ⏳ on the incoming message, a single status line edited as work progresses ("Checking opening hours for 92 places…"), removed when the answer arrives; ✅ or ❌ at the end.
- R25. People reply in words or with a number; polls are optional.

### 4.6 Reminders
- R21. Day-of reminder at 11:00 with place, time, ref, address and map link.
- R22. The visit is logged after the date; it feeds cuisine rotation and the don't-revisit-too-soon window.

## 5. Constraints and decisions

| Topic | Decision | Why |
|---|---|---|
| Hosting | Google Cloud always-free e2-micro VM (us-west1) with systemd. Not Fly.io. | Advait doesn't want to pay extra. The bot must run all the time (WhatsApp connection, timers, Gmail watcher). |
| Paid services | Anthropic API only, a few dollars a month. The Google Maps APIs stay within the free monthly allowance. | Cost |
| WhatsApp library | Baileys (unofficial). Self mode by default. | The official API doesn't support bots in ordinary group chats. No spare SIM. |
| Google OAuth | App set to "In production" (unverified). Onboarding over an SSH tunnel to localhost. | Logins in Testing mode expire after 7 days. Nothing needs to be public. |
| Repo | Public. No personal data or secrets in code; they belong in `.env`/environment variables. | Privacy. Note: `fixtures/Tokyo_food.csv` is Advait's saved list and is public. Ask before adding more personal data. |
| Language | Chat in English unless the users write Japanese. Restaurant emails in Japanese, then English. | |
| Stack | TypeScript/Node 22, Claude API tool loop (`claude-opus-5-5`, configurable), SQLite, Playwright, Fastify | |

## 6. Out of scope for the MVP

See `docs/BACKLOG.md`. Highlights:
- 👍/👎 rating cards after each date;
- AI phone calls to restaurants;
- Hot Pepper, OMAKASE, ebica and Toreta;
- calendar invites;
- watching full places for cancellations;
- non-dinner date ideas.

## 7. Known gaps and risks (update as they're resolved)

Findings from the 7 Oct 2026 test session:

- **The bot reported the first real booking as failed.** TableCheck's success page says "Your Reservation is Accepted", which the success check didn't recognise; fixed. The 18:30 attempt was refused ("selected time is unavailable") even though the availability API said free. The API can lag, so on that error try the nearest free time.
- **19:00 at h:armonia looked like a "request" booking** that the venue must accept. It has a different final button; not handled yet.

- **TableCheck has two booking flows.**
  - **Classic form** (`/en/shops/<slug>/reserve`), e.g. h:armonia. **Works end to end in dry run**: grid → seats-only → purpose "Date" → required Q&A "None" → guest details → TableCheck's confirmation page. The page holds the slot for 10 minutes. It reports the cancellation policy and the at-venue total, e.g. ¥500/person coperto.
  - **Newer step-by-step flow** (`/en/<slug>/reserve/message` → landing → menu), e.g. Kuss Daikanyama. Mapped as far as the menu page (stable `data-testid`s: `Landing Date Panel Opener Button`, `[data-testid=day][data-date=…]`, `Landing Time Button`, `Landing Service Category Button`, `Landing Find A Table Button`, then the menu with "Seat only reservation"). Booking isn't implemented yet; the bot reports it as unsupported.
- **TableCheck availability API:** `hub/availability_calendar` returns about 9 slots around `start_at`, so send the JST date and time. Fixed.
- **TableCheck search** returns names in `text_translations`. Fixed.
- **Tabelog** shows a Cloudflare bot check to cloud/datacenter IPs, even through a headless browser. It can't be used from cloud sessions. Try from a home connection.
- **Audit:** 13 of 59 dinner places are on TableCheck, 1 is email, and 5 are on other platforms. 37 show as "phone only", which is overstated because Tabelog was unreachable. Discovery finds many more TableCheck places near home: ~40 within 1.3 km with Friday tables.
- **Real bookings from cloud sessions** are blocked by the session's auto-mode safety classifier, even with Advait's go-ahead. A real booking needs a permission rule, or has to be run from Advait's laptop/VM.
- Sandbox only: Chromium needed the proxy CA added to `~/.pki/nssdb` (`certutil -A -t "C,," -n ccr-agent-proxy -i /root/.ccr/agent-proxy-ca.crt`).
- Google sign-in may refuse automated browsers, which would block the one-time Tabelog login.
- The first planning run is slow: one Claude call per place for its profile, plus booking-type lookups. Both are cached afterwards.

## 8. How a new session should start

1. Read this file, `README.md`, `docs/SETUP.md` and `docs/BACKLOG.md`.
2. Check what's available: `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_API_KEY`, the `BOOKING_*` variables, and network access to tablecheck.com and tabelog.com. If something is missing, ask Advait to add it in the environment settings. Never ask for keys in the chat.
3. Toward the success event:
   1. `npm install`
   2. `npx playwright@1.63.0 install chromium`
   3. `npm run import-csv -- fixtures/Tokyo_food.csv Advait "Tokyo food"`
   4. `npm run audit`
   5. `npm run chat`, then `plan wednesday 18:30`
   6. `book option N` with DRY_RUN=1
   7. Fix any failing step
   8. With Advait's explicit go-ahead, set DRY_RUN=0 and book.
