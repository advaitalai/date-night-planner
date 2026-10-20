# Product backlog

The MVP covers the items in "Done" below. Everything else is ordered roughly by value. Each entry says what it is, why it matters and any known constraint.

**Lean rule (16 Oct, Advait):** the product stays small so it doesn't need constant testing. Before adding anything, ask whether it's worth testing for as long as it exists, and prefer the agent's judgement over new rules in code.

## Next up

1. **Give the bot its own WhatsApp number** (agreed 16 Oct). Steps in SETUP §4. Fixes the linked-device outages; @mentions work.
2. **👍 / 👎 rating cards after each date** (phase 2). This could be a message the morning after ("How was X?"), stored in `visits.rating`. Ratings would then:
   - boost similar places in scoring;
   - stop places rated 👎 from being suggested again;
   - feed the cuisine rotation.

## Cut on 16 Oct (don't rebuild without a clear reason)

- Calls scheduled for later ("call at 11", "call in 30") and rescheduling them.
- Vote counting ("you both picked") and the Sunday auto-book.
- (20 Oct) The Saturday trigger, the Sunday reminder and "skip a week".
- (20 Oct) Saving a Google Maps link from the chat: save it in Google Maps; it comes in with the next CSV import.
- Email booking and the Gmail reply watcher; Tabelog booking.
- Automatic Takeout pickup from Drive; the Google onboarding web page.
- WhatsApp polls.
- Auto-cancel; the 48h "still on?".
- The detailed call outcome tree; "recap the last call" in chat.

## Dialer QA (Advait, 12 Oct): triaged (D1–D4 done 12 Oct)

| # | Item | Priority | Size | Plan |
|---|---|---|---|---|
| D1 | ✅ Name on the call is hard to write down ("Advait Alai") | P1 | S | Book under a short name staff can write in katakana: **Emily (エミリー)**. New `CALL_BOOKING_NAME`/`_KANA`; sites keep the full name. |
| D2 | ✅ Shorter opening: "seat reservation" only | P1 | S | Say 席のみ / "just seats". Mention "no set course" only if they bring up courses. |
| D3 | ✅ Don't ask the cancellation policy on the call | P1 | S–M | Look it up first (TableCheck/Tabelog page, website) with Claude. If not found, don't ask; assume 24h and say so (already the fallback). Saves ~15–20 s a call. |
| D4 | ✅ Fix mix-ups on the call (they offered 2 Oct, a past date) | P1 | S–M | Give the caller today's date, the target date with weekday, and an "authority envelope": same date only, never past dates; restate the date if they get it wrong; anything outside → note it and say we'll call back. Plus an optional flexibility window set in chat ("18:30, fine 18:00–19:30") that the caller may accept without a call back. |
| D5 | Know when they open (and good times to call) | P2 | M | Hours come from Google (cached in SQLite `places.opening_periods`, never refreshed). Refresh if >30 days old; add Google's holiday hours (`currentOpeningHours`); suggest calls just after opening or 15:00–17:00, never at peak dinner. |
| D6 | Live help mid-call (check facts, ask the couple) | P3 | L | Vapi tools/webhooks need a public URL, so after the VM. Then: a `check_slot` tool, and a WhatsApp ping "they offer 19:00, OK?" with a 30 s timeout. |

## Recommender QA (Advait, 12 Oct): triaged (W2–W4, W7, W8 done 12 Oct)

| # | Item | Status / priority | Size | Plan |
|---|---|---|---|---|
| W1 | Dessert places offered for dinner | ✅ fixed 11 Oct (`not_dinner` filter) | | Verify in the next run. |
| W2 | Say the area (Ebisu, Shibuya…) | ✅ done | S | Area from the Google address on each card: "Ebisu · 22 min by train". |
| W3 | Which travel mode is "22 min"? | ✅ done | S | Already public transport (Routes API, transit incl. walking), but when Routes fails it falls back to a straight-line guess that isn't labelled. Show "by train" / "walk" (walk when ≤ 15 min), "~" for estimates. |
| W4 | The "why" is weak ("29 min", "book ahead for weekends") | ✅ done | S–M | Pitch rules: why = why *you two*: on whose list, like a place you saved, matches the ask, a cuisine you haven't had lately, the standout dish/vibe from reviews. Never distance (own line), never booking advice. Good/bad examples in the prompt. |
| W5 | Already visited a recommended place | P2 | M | Google Places has no "visited". Maps knows from Timeline, now stored on the phone only (not in Takeout). Options: one-off Timeline export from the phone (Maps → Timeline → Export) → visits; scan Gmail for past booking confirmations → visits; `log_visit` in chat (done). |
| W6 | Live music request didn't change the options | ✅ fixed 11 Oct (must-have filter + searches + honest notes) | | Verify in the next run. |
| W7 | Live music places came as plain text (no cards, why, maps) | ✅ done | S | The bot used the `search_places` lookup and wrote freeform text. Rule: every suggestion goes through `recommend_options` cards; `search_places` only answers questions about a named place. |
| W8 | (found in triage) ~150–230 Routes calls per planning run | ✅ done | S | One per candidate. Cache travel time per place and starting point (30 days). Keeps Routes inside the free monthly cap during heavy testing. |

## Booking coverage

- **TableCheck newer flow** (`/reserve/message` → landing → menu): finish the booking steps. Decide after a week of real use (20 Oct): today those places are booked by phone. The flow is mapped in REQUIREMENTS §7. Kuss Daikanyama, TUITUI and Taro Yamada use it. On the saved list (12 Oct): 6 of 15 TableCheck places (Kuss, Picica Picica, Nakayoshi, BROWNSTONE, Chef's Theatre, Peter Luger).
- **TableCheck `postpay_optional` items** (ask Advait): The Public Place offers "【DINNER】Seating only (no meal included)" with payment type `postpay_optional`. The bot treats anything but `none` as "needs a card" and skips it. If `postpay_optional` means "pay at the venue, online payment optional", it's fine to book. Check one by hand before allowing it.
- ✅ **Wrong TableCheck slug from detection** (fixed 12 Oct): Peter Luger got `peterluger-pickup` (the takeout page). Detection now skips pickup/takeout/delivery slugs. Places detected before keep their slug until re-detected.

4. **AI phone calls: from test to production.** The Vapi adapter and test call are built. Next:
   - a Japanese caller number, since restaurants may ignore international numbers;
   - a natural Japanese voice choice;
   - real-restaurant trials in dry run, then live;
   - calling back to accept an offered alternative time.
5. **More booking platforms:** Hot Pepper Gourmet (its search API is free; booking would go through the browser), OMAKASE, ebica, Toreta and Ikyu. `detect.ts` already marks these places as `other_online`.
7. **Watch fully booked places for cancellations.** Poll TableCheck availability for places they both want that are full, and book automatically when a table frees up.
8. **Book sought-after places further ahead.** For places that fill up weeks in advance, book further out than a few days ahead.

## Planning & recommendations

- **Places API cost watch.** Searches now include Google's atmosphere attributes (live music, serves dinner…), which bill at the "Enterprise + Atmosphere" tier. Check usage in the Cloud console after a few weeks; drop the attributes from searches and fetch them only for must-have requests if it adds up.
- **Remember wishes across a conversation.** The agent combines earlier wishes when re-asking ("Thai or Mexican, with live music"); a stored "current wish" per date would make that reliable.

9. **Google Calendar invites** for both people when a booking is confirmed. Update or remove the invite when the booking changes or is cancelled.
10. **Non-dinner date ideas** from the saved lists (spa, gallery, cafés), e.g. "Saturday afternoon plan".
11. **A "midway" anchor:** somewhere between home and the office, or between two places where they'll be that day.
12. **Learn preferences from chat:** turn "too loud", "loved the counter seats" into vibe weights.
13. **Weather-aware suggestions:** terrace places only when it's dry and mild.

## Platform

14. **Official WhatsApp Business API,** if Meta's group-chat support becomes generally available. That would remove the risk of the unofficial library getting the bot's number banned.
15. **Admin page:** reservations, jobs, places and their booking channels, with manual overrides (e.g. fix a wrong TableCheck slug).

## Done (MVP)

- WhatsApp group bot with an agent loop. It answers inline replies and "planner", listens to the rest, and either of you can decide (16 Oct).
- Saved lists: Takeout CSV import.
- Recommender:
  - parses free-text requests;
  - starts from home or the office;
  - rotates cuisines;
  - finds places similar to a named one;
  - discovers places beyond the saved lists;
  - checks availability before proposing;
  - writes pitches using only stored facts.
- Booking through TableCheck, else an AI phone call: book, change and cancel. Cancellation policies are read from the booking, the call or the website, and turned into a deadline reminder.
- Weekly rhythm:
  - one "still on?" a day before the free-cancellation deadline;
  - reminder on the day;
  - visit log after the date.
- Bookability audit script.
