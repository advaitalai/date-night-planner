# Date Night Planner: requirements

Owner: Advait. Users: Advait and Emily (a couple in Tokyo).
Status: MVP built on branch `claude/festive-volta-e3nm17` (PR #1). **First real booking made on 7 Oct 2026:** h:armonia, Fri 9 Oct 18:00, 2 people, seats only, via TableCheck. Live in WhatsApp with Emily since 12 Oct. **16 Oct: cut to a lean scope** (§4.0) so there's less to test and maintain.

## 1. Problem

Planning the weekly date night means choosing a place, checking it's free, booking it, and keeping track of cancellation deadlines. Booking is the most annoying part. The goal is an agent that does all of this inside the WhatsApp chat Advait and Emily already use. The humans only decide and show up.

## 2. MVP success event

> **The bot makes a real reservation for a Wednesday date night**, one that Advait and Emily chose, and posts the confirmation with the reference number and cancellation deadline.

First target: Wed 7 Oct 2026, around 18:30, near home.

## 3. People, places, defaults

| Item | Value |
|---|---|
| Home | Residia Tower Meguro Fudomae, 3-7-6 Nishigotanda, Shinagawa (Gotanda/Fudomae) |
| Work (Advait) | Arco Tower Annex, 1-8-1 Shimomeguro, Meguro (near Meguro station) |
| Usual slot | Wednesday 18:30, 2 people. Day and time must be easy to change from chat. |
| Planning cadence | Plan the weekend before: options go out Sat 10:00, a reminder Sun 10:00 if nobody has picked. Monday is too late to get tables at good places. Nothing is booked without a decision. |
| Travel limit | About 25 min from the starting point (default: home). "Near work" switches the starting point to the office. |
| Budget | ¥15,000 per person by default (can be changed) |
| Booking contact | In `.env` only, because the repo is public. Name Advait (アドヴァイト), Japanese phone 070 number, advaitalai@gmail.com. Japanese text puts the Japanese name first. |

## 4. Functional requirements

### 4.0 Lean scope (16 Oct 2026)

The core loop: Saturday options → either of you decides → the bot books (TableCheck, else a phone call) → change or cancel from the chat → one "still on?" and a day-of reminder → the visit is logged.

Cut on 16 Oct, and why:
- **Calls scheduled for later** ("call at 11", "call in 30"): both caller bugs of 12–15 Oct were here. A closed restaurant gets "they open at 17:00, reply when you'd like me to call".
- **Vote counting and the Sunday auto-book:** the agent reads the conversation instead (R3). Nothing is booked without a decision.
- **Email and Tabelog booking, Gmail and Drive watchers, the onboarding web page, polls:** parked or unused. Saved lists come in by CSV import.
- **Auto-cancel and the 48h "still on?":** one reminder, a day before free cancellation ends; it never cancels by itself.
- **The detailed call outcome tree:** one message shape (what happened, what they said, offered times, "try again?").
- **"Recap the last call" in chat:** the summary is posted after every call; `npm run logs` has the rest.

Kept on purpose: changing a booking (one call to the restaurant beats cancel + rebook), the visit log, the cancellation policy lookup.

### 4.1 Chat (WhatsApp)
- R1. The bot lives in a WhatsApp group with Advait and Emily.
- R2. Self mode (today) links the bot to Advait's own WhatsApp as a linked device; its messages are prefixed with 🤖. **Planned: its own number** (fixes the linked-device outages and makes @mentions work). **Addressing (16 Oct):** the bot answers only inline replies to its messages, messages that say "planner", or (own number) an @mention. Everything else is the two of them talking: the bot reads it as context and never acts on it.
- R3. **Decisions (16 Oct).** Either of them can decide on an option, in any words ("2", "let's do the Thai one", or one suggests and the other agrees); the agent judges it, and asks "Shall I book X?" when unsure. An opinion ("2 looks nice") isn't a decision. When the bot hears them settle it in their own conversation, it asks once to confirm ("Sounds like X. Shall I book it?") and books on a reply. No votes, no deadline auto-book.
- R4. It understands loose requests: "feeling Italian, not too far from work", "somewhere like Monna Lisa", "Thursday instead", "move it to 19:30", "cancel".

### 4.2 Saved places
- R5. It uses both people's saved Google Maps places. There is no API for those lists, so they come in through Google Takeout:
  - a CSV import from Takeout (`npm run import-csv`; `fixtures/Tokyo_food.csv` is Advait's list), redone by hand a couple of times a year. (The automatic Drive pickup was cut on 16 Oct.)
- R6. A Google Maps link pasted into the chat gets added to the sender's saved places.
- R7. A place saved by both people ranks higher.

### 4.3 Recommendations
- R8. Rotate cuisines: rank cuisines from the last ~3 dates lower.
- R9. **Pick first, then book** (changed 10 Oct 2026, from Advait's beta feedback). Options are chosen for fit: open then, distance, budget, cuisine, rotation. Live availability is not checked up front; the bot books right after the choice and reports quickly if the time is full, with the alternatives.
- R10. Go beyond the saved lists. Find similar places (by cuisine, vibe and price) and new places near the starting point. Explain the link, e.g. "similar to X on Emily's list".
- R11a. (12 Oct) Cards show the area and how you'd get there: "Ebisu, 22 min by train from home" or "6 min walk"; "~" marks an estimate. Travel is always public transport or walking, never taxi. The "why" says why it suits *them* (their lists, their request, similar to a saved place, a cuisine they haven't had lately, a standout dish); never distance or booking tips. Every suggestion is posted as cards, never as freeform text.
- R11. Each option comes with a short pitch saying why: a signature dish, the vibe ("live band"), travel time. Pitches may only use facts from stored reviews or profiles, with nothing invented.
- R12. Hard filters: open at that time, within the travel limit, bookable by the bot, not visited recently, within budget, matching any requested cuisine. Also (11 Oct):
  - **Dinner places only:** no cafés, dessert bars or bakeries (Google's `servesDinner`, place type, cuisine label), unless they ask for dessert.
  - **Must-haves are hard filters:** live music, terrace, cocktails, wine, vegetarian. A place passes if Google's attribute says yes or its reviews mention it.
  - **"New options" means new:** places already suggested for that date are left out unless asked for.
  - **Seats only:** TableCheck places whose menu is all courses are dropped before picking.
- R12a. **Honesty about misses.** If no option has an asked-for cuisine or vibe, the options message says so. The agent only describes what the recommender returned.
- R13. If too few places pass the filters, widen automatically (travel +10 then +20 min, budget ×1.5 then any) and say so. For a cuisine request ("anything Indian?") search beyond the saved lists before ever saying there's nothing. Explain what ruled places out only as a last resort.

### 4.4 Reservations
- R13a. **Seat-only bookings.** Never book courses or anything needing prepayment or a card. Pick TableCheck's seat-only item (e.g. "Reservation for seats only"), or skip the place. The ¥ amounts shown to users are average spend per person, not prices.
- R14. **The bot books itself.** Posting a link or phone number for a human to act on doesn't count. It also changes and cancels bookings.
- R15. Booking order for the **same place** (a definite "that time is full" stops and asks instead). Never move on to a different place without asking:
  1. **TableCheck** (guest booking in a headless browser).
  2. **AI phone call:** Vapi (Japanese speech, Claude for the conversation). Says it's an AI assistant, seats only, never agrees to a course or card. The transcript is read to get the outcome.
  (Email and Tabelog booking were cut on 16 Oct; places with only those are booked by phone.)
- R15a. **Calls need a go-ahead, judged like a person would** (changed 16 Oct). Deciding on a phone-only place is the go-ahead: the bot calls straight away. Anything else (cancel, change, retry, call back for an offered time) is asked first, and any clear yes counts ("ok call then", "go for it"); "no" drops it. Safe because only messages addressed to the bot can act (R2). Calls are made now or not at all: if the restaurant is closed, the bot says when it opens and waits to be told. (Replaces the 12 Oct "must contain the word call" rule and scheduled calls.)
- R15c. **Time window** (12 Oct). Each booking has the time to ask for and the latest time the bot may take without asking: by default 30 min later (prefs `flexLaterMin`), or the range they gave in chat for that date night ("6 to 7:30 all good"; "exactly 7" = no window). Applies to sites (book the free time inside the window) and calls (the caller may accept it on the call). Earlier times, other dates or conditions always come back to the chat.
- R15d. **Calls** (12 Oct): book under **Emily (エミリー)** (easy to write in katakana; sites keep the full name); open with "seat reservation" only, mention courses only if they do; know today's date and restate the booking date if they mix it up; don't ask the cancellation policy (looked up online first, else 24h assumed).
- R15b. **After each call** (simplified 16 Oct): booked → ✅ confirmation with the deadline; otherwise one message: what happened (full, busy, no answer…), a 1–2 line summary of what they said, any times they offered, and "Want me to try again, another time, or another option?" (a retry needs a yes). No retry is offered when they require a course or card, or the number was wrong (that number is dropped). A call that never connected says why in plain words (e.g. "Twilio balance is $0.12").
- R16. Google "Reserve a table" has no consumer API; it hands off to the booking site behind it, so the bot books there.
- R17. Any place with a phone number is bookable (via an AI call). Walk-in-only places are excluded.
- R18. Cancellation policy:
  - Read the policy and work out the last moment to cancel for free (assume 24h if no policy is stated, and say so).
  - The policy comes from the TableCheck page, what the restaurant said on the call, or their website (looked up after a phone booking). The call never asks about it.
  - One "still on?" a day before free cancellation ends, with the exact deadline. It never cancels by itself (auto-cancel was cut on 16 Oct).
- R19. Never fail silently. If a booking fails (slot gone, captcha, site changed), say so in the group and ask what to try next. (Changed 11 Oct: it used to move on to the next option by itself, and booked a place nobody picked.)
- R20. `DRY_RUN=1` (the default) stops before the final confirm click and sends calls to Advait instead of the restaurant. Turn it off only after the booking flow has been checked live.

### 4.5 Chat UX

- R23. Messages use WhatsApp formatting: *bold* names, short lines, blank lines between items. Never em dashes.
- R24. Show what the bot is doing: ⏳ on the incoming message, a single status line edited as work progresses ("Checking opening hours for 92 places…"), removed when the answer arrives; ✅ or ❌ at the end.
- R25. People reply in words or with a number (an inline reply to the bot). No polls (removed 16 Oct).

### 4.6 Reminders
- R21. Day-of reminder at 11:00 with place, time, ref, address and map link.
- R22. The visit is logged after the date; it feeds cuisine rotation and the don't-revisit-too-soon window.

## 5. Constraints and decisions

| Topic | Decision | Why |
|---|---|---|
| Hosting | Google Cloud always-free e2-micro VM (us-west1) with systemd. Not Fly.io. | Advait doesn't want to pay extra. The bot must run all the time (WhatsApp connection, timers). |
| Paid services | Anthropic API only, a few dollars a month. The Google Maps APIs stay within the free monthly allowance. | Cost |
| WhatsApp library | Baileys (unofficial). Self mode by default. | The official API doesn't support bots in ordinary group chats. No spare SIM. |
| Repo | Public. No personal data or secrets in code; they belong in `.env`/environment variables. | Privacy. Note: `fixtures/Tokyo_food.csv` is Advait's saved list and is public. Ask before adding more personal data. |
| Language | Chat in English unless the users write Japanese. Restaurant calls in Japanese. | |
| Stack | TypeScript/Node 22, Claude API tool loop (`claude-opus-5-5`, configurable), SQLite, Playwright, Vapi + Twilio | |

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
    - **Two layouts of the classic form** (12 Oct): an availability **grid** (h:armonia, bills Omotesando), or **date + time dropdowns** with no grid (SMOKEHOUSE): a Mobiscroll calendar (`[data-full='YYYY-M-D']`, month 0-based) and a time `<select>` that only lists free times. Both work in dry run.
    - Seat-only menu items have many names: "Seats only", "Book a Table", "Dining Table", "Bar Counter", 席のみ. Courses, set menus, drink packages, lunch/café-only items are never picked. Only payment type `none` counts (see the `postpay_optional` question in BACKLOG).
    - Required Q&A can be a checkbox acknowledgement ("enter children separately"); the bot ticks it.
    - On any form error TableCheck also shows "selected time is unavailable", so that only means full when it's the only error.
    - The menu list reloads after the time is picked; the bot waits, and checks the item's checkbox really got ticked.
  - **403s:** TableCheck answers 403 to bursts of requests (seen from the cloud sandbox after ~50 requests in a few minutes). The bot retries twice (1.5 s, 3 s) and never caches an error. Before 12 Oct a 403 page was read as "classic form, seat-only", which cached wrong verdicts for a week (cache key now `tcinfo3:`).
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

1. Read `docs/STATUS.md` (current state and preferences), this file, `README.md`, `docs/SETUP.md` and `docs/BACKLOG.md`.
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
