# User stories

What this build does, as user stories, with how well each one is tested so far. Used to plan QA so Advait isn't the one finding bugs.

**Test status**
- ✅ Seen working in a real run (beta chat, real booking or test call)
- 🧪 Unit-tested only, never seen in a real run
- ⚠️ Built, but neither unit-tested nor seen in a real run
- ❌ Seen failing; fix built but not yet re-run
- ⏳ Not built

Last updated: 12 Oct 2026.

## A. Chat and experience

| # | Story | Status |
|---|---|---|
| A1 | As Advait, I want to talk to the planner in our WhatsApp group in plain words or a number, so that I never learn commands. | ✅ |
| A2 | As a user, I want to see what the bot is doing (one status line, ⏳ then ✅), so that I know it's working and on what. | ✅ |
| A3 | As a user, I want options as clean cards (bold names, short lines, no em dashes), so that I can scan them on my phone. | ✅ (new area/travel line 🧪) |
| A4 | As a user, I want a short hello with ideas of what to say, so that I know how to start. | ✅ |
| A5 | As Emily, I want to pick separately from Advait and have it book once we agree (and ask when we don't), so that neither of us decides alone. | 🧪 never run with two people |
| A6 | As a user, I want the bot to be honest: never claim a booking, a match ("live music") or a cancellation that didn't happen, so that I can trust it. | ❌ round 3 claimed false matches; fix not yet re-run |
| A7 | As a user, I want one reply per message, not a repeat of what was just posted, so that the chat stays clean. | ❌ round 3 doubled up; fix not yet re-run |

## B. Saved places

| # | Story | Status |
|---|---|---|
| B1 | As a couple, we want our Google Maps saved places used, so that suggestions start from places we already like. | ✅ Advait's list (CSV) · ⚠️ automatic Takeout import from Drive · ⏳ Emily's list |
| B2 | As a user, I want to paste a Google Maps link to add a place, so that new finds go straight in. | ⚠️ |
| B3 | As a user, I want to say "we went to X" and not have it suggested again soon, so that we don't get repeats. | 🧪 (Timeline import ⏳) |

## C. Recommendations

| # | Story | Status |
|---|---|---|
| C1 | As a couple, we want options for the coming Wednesday on Saturday morning, so that we can book good places in time. | ⚠️ Saturday kickoff never seen live |
| C2 | As a couple, we want cuisines to rotate, so that we don't eat the same thing every week. | 🧪 |
| C3 | As a user, I want loose requests understood ("Thai or Mexican", "near work", "under ¥8,000"), so that I can just say what I feel like. | ✅ cuisines · ⚠️ "near work", budget |
| C4 | As a user, I want must-haves like live music treated as must-haves, so that every option has it, or I'm told none do. | ❌ round 3; fix 🧪 |
| C5 | As a user, I want "new options" to mean places I haven't just seen, so that asking again is worth it. | ❌ round 3; fix 🧪 |
| C6 | As a couple, we want new places beyond our lists, linked to ones we saved ("like X on Emily's list"), so that we discover more. | ✅ discovery · ⚠️ "similar to X" |
| C7 | As a user, I want each option to say what it is and why it suits us (not distance or booking tips), so that I can choose quickly. | ✅ what · 🧪 new why rules |
| C8 | As a user, I want the area and how we'd get there ("Ebisu, 22 min by train"), so that I know the trip. | 🧪 |
| C9 | As a couple, we want dinner places only, bookable for seats (no dessert bars, no course-only), so that options are realistic. | ❌ round 3 dessert counter; fix 🧪 |
| C10 | As a user, I want it to widen the search before giving up, and say honestly what it couldn't find, so that I'm never stuck. | ✅ widening · 🧪 "couldn't find" notes |
| C11 | As a user, I want to ask about an option ("tell me more about 2"), so that I can decide. | ✅ |

## D. Booking

| # | Story | Status |
|---|---|---|
| D1 | As a couple, we want the bot to book the place we pick by itself, seats only, so that we never deal with booking. | ✅ TableCheck classic (real booking) · ⏳ TableCheck newer flow · ⚠️ Tabelog · ⚠️ email |
| D2 | As a user, I want it to book only the place we chose, never another without asking, so that there are no surprises. | ❌ round 3 booked Bruna; fix 🧪 |
| D3 | As a user, I want it to take a time up to 30 min later (or within a range I give) without asking, and ask about anything else, so that small changes don't need me. | 🧪 |
| D4 | As a user, I want a clear confirmation with the time, name and free-cancellation deadline, so that I know exactly what's booked. | ✅ |
| D5 | As a user, I want failures explained in one plain sentence with the next step, so that I know what to do. | 🧪 rewritten |

## E. Phone calls

| # | Story | Status |
|---|---|---|
| E1 | As Advait, I want the bot to ask before any call (book, change, cancel, retry), so that calls are always under our control. | 🧪 |
| E2 | As a restaurant, I want a short, polite Japanese call that says it's an AI, asks for seats under a name I can write (エミリー) and handles date mix-ups, so that I can take the booking easily. | ✅ test calls (English to Advait, Japanese to Emily) · 🧪 new script (name, window, date check) |
| E3 | As Advait, I want the result of each call and a sensible next question (full → book the offered time?, busy → try in 30 min?), so that I just answer yes or no. | ✅ full / wrong number / booked / cancelled (round 3) · 🧪 the rest of the tree |
| E4 | As Advait, I want to say "call at 17:00" or "try again in 30 min", so that calls happen when the restaurant answers. | ⚠️ |
| E5 | As Advait, I want a failed call explained (e.g. "Twilio balance is $0.12"), so that I can fix it. | 🧪 |
| E6 | As Advait, I want the cancellation policy found online rather than asked, so that calls are shorter and cheaper. | 🧪 |

## F. After booking

| # | Story | Status |
|---|---|---|
| F1 | As a user, I want to change a booking's time, day or party size, so that plans can shift. | ⚠️ never run on TableCheck or by phone |
| F2 | As a user, I want to cancel a booking from the chat, so that I don't have to call or log in. | ✅ by phone (dry run) · ⚠️ TableCheck |
| F3 | As a couple, we want a "still on?" check 48h and 24h before the free-cancellation deadline, so that we never pay a fee. | ⚠️ never fired live |
| F4 | As a couple, we want a reminder on the day (place, time, map), so that we just show up. | ⚠️ |
| F5 | As a couple, we want the visit logged after the date, so that rotation and repeats work. | ⚠️ |
| F6 | As a user, I want auto-cancel only if I turned it on, so that nothing is cancelled behind my back. | 🧪 |

## G. Weekly rhythm and settings

| # | Story | Status |
|---|---|---|
| G1 | As a couple, we want to skip a week, so that it doesn't plan when we're away. | ✅ |
| G2 | As a couple, we want a Sunday nudge and a Sunday-evening decision, so that a table gets booked in time. | ✅ fired (late, after downtime) · 🧪 stale reminders dropped |
| G3 | As a user, I want to change our usual day, time, budget or travel limit in chat, so that defaults fit us. | ⚠️ |

## H. Running it

| # | Story | Status |
|---|---|---|
| H1 | As Advait, I want a dry-run mode where nothing real is booked and calls come to me, so that I can test safely. | ✅ |
| H2 | As Advait, I want running costs to stay around $7–15 a month with no paid hosting, so that it's worth it. | ⚠️ not measured |
| H3 | As Advait, I want no secrets or personal details in the public repo, so that we stay private. | ✅ |
| H4 | As a couple, we want it running all the time and surviving restarts, so that Saturday options and reminders always arrive. | ⚠️ laptop only so far |
