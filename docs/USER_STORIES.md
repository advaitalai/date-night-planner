# User stories and how tested they are

Grouped by epic. For each story: is it **checked by a test**, how did it go when **used for real**, and what's **not checked yet**.

**Columns**
- **Checked by a test:** a small program tries it and checks the result, with no person involved (pretend WhatsApp and pretend calls). Yes / Partly / No.
- **Used for real:** how it went when you and Emily used it (12–15 Oct). Worked / Broke (fixed since, not used again yet) / Changed 16 Oct (new behaviour, not used yet) / Not yet.

Last updated: 16 Oct 2026, after the lean cut. What was cut, and why: end of this page.

## 1. Chat (WhatsApp)

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| A1 | As Advait or Emily, I want to talk to the bot in plain words or a number, so I never learn commands. | Partly: the bot's replies yes; WhatsApp itself no | Broke (fixed since): messages stopped arriving for hours | WhatsApp delivery, reconnects (own number planned) |
| A2 | As a user, I want to see what the bot is doing (status line, ⏳ then ✅). | No | Worked | |
| A3 | As a user, I want options as clean cards (area, travel, why, map link). | Yes | Worked | |
| A4 | As a user, I want a short hello with ideas of what to say. | No | Worked | |
| A5 | As a couple, we want either of us to decide in our own words, and the bot to check when it isn't sure. | Partly: confirming a decision it heard yes; reading "2" / "let's do it" needs the agent (P0-7) | Changed 16 Oct | P0-7 through the agent |
| A6 | As a couple, we want the bot to answer only when we reply to it (or say "planner"), and just listen otherwise. | Yes | Changed 16 Oct | Inline replies on the real WhatsApp |
| A7 | As a user, I want every request answered, never left hanging. | Partly | Broke (fixed since): "Cancel!" got no reply | |

## 2. Recommender

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| C1 | As a couple, we want options every Saturday 10:00 for next Wednesday and a Sunday reminder if we haven't picked. Nothing is booked without a decision. | Partly: scheduling only | Worked: fired 10–11 Oct | A full week on a fake clock |
| C2 | As a couple, we want cuisines to rotate week to week. | Yes | Not yet | |
| C3 | As a user, I want loose requests understood ("Thai or Mexican", "near work", "under ¥8,000"). | Yes for cuisines | Worked: Thai/Mexican | "near work", budget |
| C4 | As a user, I want must-haves (live music) treated as must-haves, or told honestly none fit. | Yes | Worked | |
| C5 | As a user, I want "new options" to mean new places. | Yes | Worked | |
| C6 | As a couple, we want places beyond our lists, linked to ones we saved. | Yes | Worked | "similar to X" requests |
| C7 | As a user, I want each card to say what it is and why it suits us. | Yes | Worked | |
| C8 | As a couple, we want dinner places only, open that day (no dessert bars, nothing closed). | Yes | Broke (fixed since): a temporarily closed place was offered | |
| C9 | As a user, I want "tell me more" and review summaries for an option. | No | Worked | |
| C10 | As a user, I want "we went to X" to stop it being suggested. | Yes | Not yet | |

## 3. Booking

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| D1 | As a couple, we want the bot to book our pick itself: TableCheck if it can, else a phone call. Seats only. | Yes | Worked: by phone; TableCheck real booking on 7 Oct | TableCheck's newer flow (not built) |
| D2 | As a user, if our pick can't be booked, I want to be asked, never have another place booked. | Yes | Worked | |
| D3 | As a user, I want it to take a time up to 30 min later, or within a range I give, without asking. | Yes | Not yet | |
| D4 | As a user, I want a clear confirmation: place, date, time, party size, name, free-cancel deadline. | Yes | Worked | |
| D5 | As a user, I want failures explained in plain words with the next step. | Yes | Worked | |

## 4. Caller (phone calls)

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| E1 | As a couple, we want deciding on a phone-only place to be the go-ahead to call, and any clear yes to count for other calls. | Yes | Changed 16 Oct | P0-5 through the agent ("ok go ahead") |
| E2 | As Advait, I want "no" / "don't call" to drop a call the bot asked about. | Yes | Changed 16 Oct (nothing is scheduled any more) | |
| E4 | As Advait, I want a closed restaurant not called: tell me when they open, and call when I say. | Yes | Changed 16 Oct | |
| E5 | As a restaurant, I want a short, polite Japanese call under a name I can write (エミリー). | Yes for the script | Worked: booked and cancelled in Japanese | |
| E6 | As Advait, after each call I want what happened, a short summary of what they said, any times offered, and "try again?". | Yes | Worked (older, longer messages) | |
| E8 | As Advait, I want failed calls explained in plain words (e.g. Twilio balance). | Yes | Not yet | |

## 5. After booking

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| F1 | As a user, I want to change a booking's time, day or party size (one call, not cancel + rebook). | No | Not yet | Everything (test to add) |
| F2 | As a user, I want to cancel from the chat (by call, or "I cancelled it myself"). | Yes (by call, P0-5) | Worked: cancelled by phone; Broke (fixed since): first "Cancel!" swallowed | TableCheck cancel |
| F3 | As a couple, we want one "still on?" a day before free cancellation ends, with the exact deadline. The deadline comes from TableCheck, the call, or the website, else 24h assumed. | Yes (scheduled once) | Worked: the 24h one fired | |
| F4 | As a couple, we want a reminder on the day. | Yes (sent once) | Broke (fixed since): sent twice | |
| F5 | As a couple, we want the visit logged after the date, for rotation. | No | Not yet | Everything |

## 6. Weekly rhythm and settings

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| G1 | As a couple, we want to skip a week. | No | Worked (a test skip leaked into real use; `npm run fresh-start` now clears it) | |
| G2 | As a user, I want to change our usual day, time, budget or travel limit in chat. | No | Not yet | Everything |

## 7. Saved places

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| B1 | As a couple, we want our Google Maps saved places used (Takeout CSV import, by hand a couple of times a year). | Yes | Worked: Advait's list | Emily's list |

## 8. Logs and debugging

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| I1 | As Advait, I want every call kept with its transcript. | Yes | Worked (5 calls in the retro) | |
| I2 | As Advait, I want every booking attempt kept with the site's error. | Yes | Worked | |
| I4 | As Advait, I want logs saved to files and a weekly retro report. | No | Worked (`npm run retro`) | |

## 9. Running it

| # | Story | Checked by a test | Used for real | Not checked yet |
|---|---|---|---|---|
| H1 | As Advait, I want a dry-run mode where nothing real happens. | Yes | Worked | |
| H2 | As Advait, I want it to keep running: survive errors, restarts and timeouts, and only one copy at a time. | Partly | Broke (fixed since): crashed on a timeout; 146 reconnects | Reconnect handling, second copy refused |
| H3 | As Advait, I want costs low (~$7–15/month). | No | Worked: calls $0.36 for the week; Claude not measured | Claude spend |
| H4 | As a couple, we want it always on (server, not laptop). | Not built | Not built | Later; own number first |

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
