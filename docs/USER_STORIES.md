# User stories and how tested they are

Grouped by epic. For each story: is there an **automated test** (runs without anyone, `npm test` or `npm run p0`), how did it do in **real use** (12–15 Oct with Emily), and what's **not tested yet**.

**Key**
- Automated: ✅ yes · ⚠️ partly · ❌ no
- Real use: ✅ worked · 🐞 broke (fixed since, not yet retested) · — not used yet
- ⏳ = not built

Last updated: 16 Oct 2026 (after the 12–15 Oct retro).

## 1. Chat (WhatsApp)

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| A1 | As Advait or Emily, I want to talk to the bot in our group in plain words or a number, so I never learn commands. | ⚠️ the bot's replies yes; WhatsApp itself no | 🐞 messages stopped arriving for hours (broken link, old version, skipped synced messages, crash) | WhatsApp delivery, reconnects, two copies running |
| A2 | As a user, I want to see what the bot is doing (status line, ⏳ then ✅). | ❌ | ✅ | |
| A3 | As a user, I want options as clean cards (area, travel, why, map link). | ✅ | ✅ | |
| A4 | As a user, I want a short hello with ideas of what to say. | ❌ | ✅ | |
| A5 | As Emily, I want my picks to count, and it books only when we both agree. | ✅ | ✅ Emily recognised; ⚠️ never both picked the same option | Two real picks in a row |
| A6 | As a couple, we want chit-chat between us ignored ("babe, do you like any of these?"). | ❌ | ✅ | Inline replies, @mentions |
| A7 | As a user, I want every request answered once, never silently dropped. | ⚠️ | 🐞 "Cancel!" got no reply | |

## 2. Recommender

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| C1 | As a couple, we want options every Saturday 10:00 for next Wednesday, a Sunday nudge, and a Sunday-evening decision. | ⚠️ scheduling only | ✅ fired 10–11 Oct (old wording) | A full week on a fake clock |
| C2 | As a couple, we want cuisines to rotate week to week. | ✅ | — | |
| C3 | As a user, I want loose requests understood ("Thai or Mexican", "near work", "under ¥8,000"). | ✅ cuisines | ✅ Thai/Mexican | "near work", budget |
| C3a | As a user, I want spend per person on each card ("~¥6,000 pp"). | ⏳ | ⏳ | |
| C4 | As a user, I want must-haves (live music) treated as must-haves, or told honestly none fit. | ✅ | ✅ | |
| C5 | As a user, I want "new options" to mean new places. | ✅ | ✅ | |
| C6 | As a couple, we want places beyond our lists, linked to ones we saved. | ✅ | ✅ | "similar to X" requests |
| C7 | As a user, I want each card to say what it is and why it suits us. | ✅ | ✅ | |
| C8 | As a couple, we want dinner places only, open that day (no dessert bars, nothing closed). | ✅ | 🐞 a temporarily closed place was offered | |
| C9 | As a user, I want "tell me more" and review summaries for an option. | ❌ | ✅ | |
| C10 | As a user, I want "we went to X" to stop it being suggested. | ✅ | — | |

## 3. Booking

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| D1 | As a couple, we want the bot to book our pick itself, fastest sure way first (site, then email, then a call), seats only. | ✅ TableCheck (dry run) | ✅ by phone; TableCheck real booking only on 7 Oct | Tabelog (needs a login), email (parked), TableCheck's newer flow (⏳) |
| D2 | As a user, if our pick can't be booked, I want to be asked, never have another place booked. | ✅ | ✅ | |
| D3 | As a user, I want it to take a time up to 30 min later, or within a range I give, without asking. | ✅ | — | |
| D4 | As a user, I want a clear confirmation with time, name and free-cancellation deadline. | ✅ | ✅ | |
| D5 | As a user, I want failures explained in plain words with the next step. | ✅ | ✅ | |

## 4. Caller (phone calls)

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| E1 | As Advait, I want no call without the word "call" from one of us. | ✅ | ✅ asked for "call" correctly | |
| E2 | As Advait, I want "don't call" to stop any call, including one scheduled for later. | ✅ | 🐞 a dropped call still ran and booked | Full chat flow (P0-11) |
| E3 | As Advait, I want a changed time ("19:15 instead") to replace the earlier scheduled call. | ✅ | 🐞 the new time was lost and the old time was called | Full chat flow (P0-12) |
| E4 | As Advait, I want to schedule calls ("call at 11") and see opening hours first. | ✅ | ✅ | |
| E5 | As a restaurant, I want a short, polite Japanese call under a name I can write (エミリー). | ✅ script | ✅ booked and cancelled in Japanese | |
| E6 | As Advait, I want each call's result and a sensible next question (full, busy, no answer, unclear…). | ✅ | ✅ no answer, unclear, booked, cancelled | Busy, voicemail, wrong number, course required |
| E7 | As Advait, I want a scheduled booking call skipped if we already have a booking that day. | ✅ | — | |
| E8 | As Advait, I want failed calls explained (e.g. Twilio balance) and the policy looked up online. | ✅ | — | |

## 5. After booking

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| F1 | As a user, I want to change a booking's time, day or party size. | ❌ | — | Everything |
| F2 | As a user, I want to cancel from the chat (by call, or "I cancelled it myself"). | ⚠️ | ✅ cancelled by phone; 🐞 first "Cancel!" swallowed | TableCheck cancel |
| F3 | As a couple, we want "still on?" 48h and 24h before the free-cancel deadline. | ⚠️ | ✅ 24h reminder fired | 48h one |
| F4 | As a couple, we want a reminder on the day. | ✅ (sent once) | 🐞 sent twice | |
| F5 | As a couple, we want the visit logged after the date, for rotation. | ❌ | — | Everything |
| F6 | As a user, I want auto-cancel only if I turned it on. | ✅ | — | |

## 6. Weekly rhythm and settings

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| G1 | As a couple, we want to skip a week. | ❌ | ✅ (a test skip leaked into real use; `npm run fresh-start` now clears it) | |
| G2 | As a user, I want to change our usual day, time, budget or travel limit in chat. | ❌ | — | Everything |

## 7. Saved places

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| B1 | As a couple, we want our Google Maps saved places used and kept up to date from Takeout. | ✅ CSV import | ✅ Advait's list | Drive pickup (needs Google connected), Emily's list (⏳) |

## 8. Logs and debugging

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| I1 | As Advait, I want every call kept with its transcript. | ✅ | ✅ (5 calls in the retro) | |
| I2 | As Advait, I want every booking attempt kept with the site's error. | ✅ | ✅ | |
| I3 | As Advait, I want to ask "recap the last call" in chat. | ❌ | 🐞 said it couldn't see transcripts (tool added since) | |
| I4 | As Advait, I want logs saved to files and a weekly retro report. | ❌ | ✅ (`npm run retro`) | |
| I5 | As Advait, I want a private alert when something breaks. | ⏳ | ⏳ | |

## 9. Running it

| # | Story | Automated | Real use | Not tested yet |
|---|---|---|---|---|
| H1 | As Advait, I want a dry-run mode where nothing real happens. | ✅ | ✅ | |
| H2 | As Advait, I want it to keep running: survive errors, restarts and timeouts, and only one copy at a time. | ⚠️ | 🐞 crashed on a timeout; 146 reconnects | Reconnect handling, second copy refused |
| H3 | As Advait, I want costs low (~$7–15/month). | ❌ | ✅ calls $0.36 for the week; Claude not measured | Claude spend |
| H4 | As a couple, we want it always on (server, not laptop). | ⏳ | ⏳ | |

## Rules checked on every test (not stories)

- Never claim a booking, change, cancellation or "dropped call" unless it really happened.
- Never claim options match a wish unless they do; say what wasn't found.
- One reply per message, nothing swallowed.
- House style: rich formatting, short lines, no em dashes.
- No call without "call"; dry run never books or calls a restaurant.
