# User stories and how tested they are

Grouped by epic.

**Columns**
- **Test coverage:** whether an automated test checks it (Covered / Partial / None).
- **Production:** how it held up in live use with Emily (Validated / Bug fixed, revalidate / Unvalidated / In progress).
- **Gaps:** what neither a test nor live use has checked yet.

Last updated: 20 Oct 2026 (own number, Concierge). Lean cut on 16 Oct. What was cut, and why: end of this page.

## 1. Chat (WhatsApp)

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| A1 | As Advait or Emily, I want to talk to the bot in plain words or a number, so I never learn commands. | Partial: the bot's replies yes; WhatsApp itself no | Bug fixed, revalidate: messages stopped arriving for hours | WhatsApp delivery, reconnects (own number planned) |
| A2 | As a user, I want to see what the bot is doing (status line, ⏳ then ✅). | None | Validated | |
| A3 | As a user, I want options as clean cards (area, travel, why, map link). | Covered | Validated | |
| A4 | As a user, I want a short hello with ideas of what to say. | None | Validated | |
| A5 | As a couple, we want either of us to decide in our own words, and the bot to check when it isn't sure. | Covered (P0-7, with the AI, 16 Oct) | Unvalidated (changed 16 Oct) | |
| A6 | As a couple, we want the bot to answer only when we reply to it or call it by name ("Concierge", "planner"), and just listen otherwise. | Covered | Unvalidated (changed 16 Oct) | Inline replies on the real WhatsApp |
| A8 | As a couple, we want the bot on its own WhatsApp number ("Concierge"), not Advait's account. | Partial: name and who's-who rules yes; linking no | In progress (20 Oct) | First messages on the new number |
| A7 | As a user, I want every request answered, never left hanging. | Partial | Bug fixed, revalidate: "Cancel!" got no reply | |

## 2. Recommender

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| C1 | As a couple, we want options every Saturday 10:00 for next Wednesday and a Sunday reminder if we haven't picked. Nothing is booked without a decision. | Partial: scheduling only | Validated: fired 10–11 Oct | A full week on a fake clock |
| C2 | As a couple, we want cuisines to rotate week to week. | Covered | Unvalidated | |
| C3 | As a user, I want loose requests understood ("Thai or Mexican", "near work", "under ¥8,000"). | Covered for cuisines | Validated: Thai/Mexican | "near work", budget |
| C4 | As a user, I want must-haves (live music) treated as must-haves, or told honestly none fit. | Covered | Validated | |
| C5 | As a user, I want "new options" to mean new places. | Covered | Validated | |
| C6 | As a couple, we want places beyond our lists, linked to ones we saved. | Covered | Validated | "similar to X" requests |
| C7 | As a user, I want each card to say what it is and why it suits us. | Covered | Validated | |
| C8 | As a couple, we want dinner places only, open that day (no dessert bars, nothing closed). | Covered | Bug fixed, revalidate: a temporarily closed place was offered | |
| C9 | As a user, I want "tell me more" and review summaries for an option. | None | Validated | |
| C10 | As a user, I want "we went to X" to stop it being suggested. | Covered | Unvalidated | |

## 3. Booking

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| D1 | As a couple, we want the bot to book our pick itself: TableCheck if it can, else a phone call. Seats only. | Covered | Validated: by phone; TableCheck real booking on 7 Oct | TableCheck's newer flow (not built) |
| D2 | As a user, if our pick can't be booked, I want to be asked, never have another place booked. | Covered | Validated | |
| D3 | As a user, I want it to take a time up to 30 min later, or within a range I give, without asking. | Covered | Unvalidated | |
| D4 | As a user, I want a clear confirmation: place, date, time, party size, name, free-cancel deadline. | Covered | Validated | |
| D5 | As a user, I want failures explained in plain words with the next step. | Covered | Validated | |

## 4. Caller (phone calls)

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| E1 | As a couple, we want deciding on a phone-only place to be the go-ahead to call, and any clear yes to count for other calls. | Covered (P0-5, with the AI, 16 Oct) | Unvalidated (changed 16 Oct) | |
| E2 | As Advait, I want "no" / "don't call" to drop a call the bot asked about. | Covered | Unvalidated (changed 16 Oct; nothing is scheduled any more) | |
| E4 | As Advait, I want a closed restaurant not called: tell me when they open, and call when I say. | Covered | Unvalidated (changed 16 Oct) | |
| E5 | As a restaurant, I want a short, polite Japanese call under a name I can write (エミリー). | Covered for the script | Validated: booked and cancelled in Japanese | |
| E6 | As Advait, after each call I want what happened, a short summary of what they said, any times offered, and "try again?". | Covered | Validated (older, longer messages) | |
| E8 | As Advait, I want failed calls explained in plain words (e.g. Twilio balance). | Covered | Unvalidated | |

## 5. After booking

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| F1 | As a user, I want to change a booking's time, day or party size (one call, not cancel + rebook). | None | Unvalidated | Everything (test to add) |
| F2 | As a user, I want to cancel from the chat (by call, or "I cancelled it myself"). | Covered (by call, P0-5) | Validated by phone (bug fixed: the first "Cancel!" was swallowed) | TableCheck cancel |
| F3 | As a couple, we want one "still on?" a day before free cancellation ends, with the exact deadline. The deadline comes from TableCheck, the call, or the website, else 24h assumed. | Covered (scheduled once) | Validated: the 24h one fired | |
| F4 | As a couple, we want a reminder on the day. | Covered (sent once) | Bug fixed, revalidate: sent twice | |
| F5 | As a couple, we want the visit logged after the date, for rotation. | None | Unvalidated | Everything |

## 6. Weekly rhythm and settings

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| G1 | As a couple, we want to skip a week. | None | Validated (a test skip leaked into real use; `npm run fresh-start` now clears it) | |
| G2 | As a user, I want to change our usual day, time, budget or travel limit in chat. | None | Unvalidated | Everything |

## 7. Saved places

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| B1 | As a couple, we want our Google Maps saved places used (Takeout CSV import, by hand a couple of times a year). | Covered | Validated: Advait's list | Emily's list |

## 8. Logs and debugging

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| I1 | As Advait, I want every call kept with its transcript. | Covered | Validated (5 calls in the retro) | |
| I2 | As Advait, I want every booking attempt kept with the site's error. | Covered | Validated | |
| I4 | As Advait, I want logs saved to files and a weekly retro report. | None | Validated (`npm run retro`) | |

## 9. Running it

| # | Story | Test coverage | Production | Gaps |
|---|---|---|---|---|
| H1 | As Advait, I want a dry-run mode where nothing real happens. | Covered | Validated | |
| H2 | As Advait, I want it to keep running: survive errors, restarts and timeouts, and only one copy at a time. | Partial | Bug fixed, revalidate: crashed on a timeout; 146 reconnects | Reconnect handling, second copy refused |
| H3 | As Advait, I want costs low (~$7–15/month). | None | Validated: calls $0.36 for the week; Claude not measured | Claude spend |
| H4 | As a couple, we want it always on (server, not laptop). | None | In progress (20 Oct, Google Cloud e2-micro) | A week running on the server |

## Rules checked on every test (not stories)

- Never claim a booking, change, cancellation or dropped call unless it really happened.
- Never claim options match a wish unless they do; say what wasn't found.
- Only messages addressed to the bot can book or call anything.
- House style: rich formatting, short lines, no em dashes.
- A dry run never books or calls a restaurant.

## Cut on 16 Oct (lean product)

| Story | Why it went |
|---|---|
| C1 part: Sunday auto-book of the top vote | The bot shouldn't book without a decision. |
| C3a: spend per person on cards | Not built; not needed. |
| D1 part: email and Tabelog booking | Parked or unused; phone covers those places. |
| E3: changing a scheduled call's time | No scheduled calls any more (both caller bugs were there). |
| E4 part: "call at 11", "call in 30" | Same. |
| E6 part: the detailed outcome tree | One message shape is enough. |
| E7: skip a scheduled call if already booked | No scheduled calls. |
| E8 part: policy lookup | Moved to F3, kept. |
| F3 part: the 48h "still on?" | One reminder is enough. |
| F6: auto-cancel | An unasked action on a real booking. |
| B1 part: Google Drive pickup, onboarding page | A CSV import twice a year is fine. |
| I3: "recap the last call" in chat | The summary is posted after every call. |
| I5: private alert | Not built; not now. |
| Polls | Unused. |
