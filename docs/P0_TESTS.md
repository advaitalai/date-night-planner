# P0 tests (launch blockers)

The small set that must pass before Emily joins and the first real booking. Agreed with Advait on 12 Oct: no big automated suite yet, just these. Run them in a cloud session with `ANTHROPIC_API_KEY` set (the bot itself runs; WhatsApp is replaced by feeding messages to `handleMessage`, calls are faked, TableCheck runs for real in `DRY_RUN=1`).

**How to run:** `npm run p0` (all, through the agent; needs `ANTHROPIC_API_KEY`, or `PLANNER_ANTHROPIC_API_KEY` in cloud sessions), `npm run p0 -- P0-2 P0-5` (some), `npm run p0 -- --tools` (no LLM: the same steps through the tools the agent should call, so it checks the booking rules but not the model). Data goes to `data/p0` (`P0_DATA_DIR` to change), never the real database. It forces `DRY_RUN=1` and `CALL_FAKE=booked` (calls are answered without dialing). A report is written to `data/p0/p0-report.md`. In the cloud sandbox also set `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

- Each TableCheck dry run **holds a real table for 10 minutes** (the confirmation page). Don't rerun P0-2 on the same slot within 10 minutes, or it looks full. Only P0-2 touches TableCheck for real; P0-3/4/7 use a stub.
- TableCheck 403s bursts of requests; the harness tries the known-bookable places first (`P0_TABLECHECK`, default "SMOKEHOUSE,bills Omotesando").

**Results 12 Oct (cloud session, no Anthropic key reached the shell):** `--tools` run: P0-2, 3, 4, 5, 7 ✅. P0-1 and P0-6 need the agent: not run yet. Agent-level runs of all seven are still to do.

| # | Case | Steps | Pass when | Status |
|---|---|---|---|---|
| P0-1 | Options look right | Import `fixtures/Tokyo_food.csv`; Advait: "plan wednesday" | 1–3 cards, each with what, why (no distance or booking tips), area and "by train"/"walk", map link; no dessert places; no em dashes; one message | ⬜ needs the agent |
| P0-2 | Books only the pick | Pick a TableCheck option ("2") | "🧪 would be booked" for that place only; `booking_log` shows only that place | ✅ tools 12 Oct (real TableCheck dry run, SMOKEHOUSE and bills Omotesando); ⬜ agent |
| P0-3 | Full: nothing else booked | Pick a place whose time is full (or fake `full`) | Says full, lists free times or asks; no other place tried | ✅ tools 12 Oct (full by API, and API-free but form-full); ⬜ agent |
| P0-4 | Window | Fake full at 18:30 with 18:45 free | Books 18:45 and says it's inside the 18:30–19:00 window | ✅ tools 12 Oct (after a fix: the dry-run message didn't mention the window); ⬜ agent |
| P0-5 | No call without a yes | Pick a phone-only place | Asks "Shall I call…?"; `call_log` empty; "call" → one (fake) call | ✅ tools 12 Oct; ⬜ agent |
| P0-6 | Honest misses | "new options, Mexican with live music" (none nearby) | Says what wasn't found; never claims a match; different places from before | ⬜ needs the agent |
| P0-7 | Two people agree | Advait "2", then Emily "2" (non-solo mode) | Books after the second pick, not the first; different picks → asks | ✅ tools 12 Oct; ⬜ agent |
| P0-8 | Emily recognised | Live, in WhatsApp | Log shows `[in] Emily: …` | ⬜ live check by Advait |
| P0-9 | Chit-chat ignored | Live: "see you at 7" between them | No reply, ⏳ removed | ⬜ live check by Advait |
| P0-10 | Real booking recorded | `DRY_RUN=0`, real pick | ✅ message with deadline; reservation saved; "still on?" jobs scheduled | ⬜ at launch |
