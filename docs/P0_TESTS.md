# P0 tests (launch blockers)

The small set that must pass before Emily joins and the first real booking. Agreed with Advait on 12 Oct: no big automated suite yet, just these. Run them in a cloud session with `ANTHROPIC_API_KEY` set (the bot itself runs; WhatsApp is replaced by feeding messages to `handleMessage`, calls are faked, TableCheck runs for real in `DRY_RUN=1`).

| # | Case | Steps | Pass when | Status |
|---|---|---|---|---|
| P0-1 | Options look right | Import `fixtures/Tokyo_food.csv`; Advait: "plan wednesday" | 1–3 cards, each with what, why (no distance or booking tips), area and "by train"/"walk", map link; no dessert places; no em dashes; one message | ⬜ |
| P0-2 | Books only the pick | Pick a TableCheck option ("2") | "🧪 would be booked" for that place only; `booking_log` shows only that place | ⬜ (booking step alone ✅ 12 Oct) |
| P0-3 | Full: nothing else booked | Pick a place whose time is full (or fake `full`) | Says full, lists free times or asks; no other place tried | ⬜ |
| P0-4 | Window | Fake full at 18:30 with 18:45 free | Books 18:45 and says it's inside the 18:30–19:00 window | ⬜ |
| P0-5 | No call without a yes | Pick a phone-only place | Asks "Shall I call…?"; `call_log` empty; "call" → one (fake) call | ⬜ |
| P0-6 | Honest misses | "new options, Mexican with live music" (none nearby) | Says what wasn't found; never claims a match; different places from before | ⬜ |
| P0-7 | Two people agree | Advait "2", then Emily "2" (non-solo mode) | Books after the second pick, not the first; different picks → asks | ⬜ |
| P0-8 | Emily recognised | Live, in WhatsApp | Log shows `[in] Emily: …` | ⬜ live check by Advait |
| P0-9 | Chit-chat ignored | Live: "see you at 7" between them | No reply, ⏳ removed | ⬜ live check by Advait |
| P0-10 | Real booking recorded | `DRY_RUN=0`, real pick | ✅ message with deadline; reservation saved; "still on?" jobs scheduled | ⬜ at launch |
