# Status and working notes

The running log of where the project is. **Update this at the end of every session.** It's what a new session (or a compacted one) relies on to pick up without re-asking Advait.

Last updated: 11 Oct 2026.

## Where we are

| Phase | State |
|---|---|
| 1. Simulated chat (no code) | ✅ Done 7 Oct. Advait approved the flow. |
| 2. Real booking by chatting with Claude | ✅ Done 7 Oct. **h:armonia, Fri 9 Oct 18:00, 2 people, seats only**, booked via TableCheck and kept. The first real booking (MVP success event). |
| 3. WhatsApp beta (solo, Advait only) | 🔄 In progress. Running on Advait's laptop in a WhatsApp group that has only him in it (`WA_SOLO=1`). First two beta rounds gave feedback (below), and the fixes are pushed. Next round not yet run. |
| 3b. AI phone calls | ✅ Test call worked 11 Oct (English, Advait played the restaurant and said "full"; the outcome was read correctly). Vapi + Twilio trial (US number) set up on the laptop. |
| 3c. Full WhatsApp loop with a mock call | 🔄 First run done 11 Oct (log reviewed, round 3 below). Fixes pushed; Advait reruns, then shares his own notes. Run with `BOOKING_ONLY=phone`, `DRY_RUN=1`, `CALL_LANGUAGE=en`. |
| 4. Add Emily to the group | ⏳ Only after Advait has vetted the solo flow. Don't bother Emily until it works. |
| 5. Always-on server (Google Cloud e2-micro) | ⏳ After the beta. |

## Next steps

**Handoff for the next session (12 Oct):** Advait is starting a new cloud session with `ANTHROPIC_API_KEY` so Claude can run the P0 tests itself. Do this, in order:
1. Read this file, `docs/P0_TESTS.md` and `docs/USER_STORIES.md`.
2. Run P0-1 to P0-7 (script feeding `handleMessage`, fake calls, TableCheck `DRY_RUN=1`; Chromium in the sandbox: `CHROMIUM_PATH=/opt/pw-browsers/chromium-*/chrome-linux/chrome`; use a valid-looking test phone like 090-1234-5678, never 070-0000-0000). Fix failures, rerun, push.
3. Report a pass/fail table. Then Advait does the launch checklist (`docs/SETUP.md` §9): solo check, add Emily, `DRY_RUN=0`, real booking for Wed 14 Oct, plus P0-8/9/10 live.
- Decisions today: launch blockers only, no big test suite; email booking parked; Claude Code effort high for this phase, bot stays at medium; phone calls need an upgraded Twilio, so the first booking should be a TableCheck place.

**Launch plan (12 Oct, Advait):** launch today: add Emily to the group, iterate on options, real booking for Wed 14 Oct. Full QA harness postponed; launch blockers only (see "Launch checklist" in docs/SETUP.md §9).

**Earlier plan:** E2E dry run #4 (calls to Advait, `BOOKING_ONLY=phone`) to check dialer QA (D1–D4) and recommender QA (W1–W8) fixes.

**Agreed plan (12 Oct):** dialer QA fixes (done) → Advait's recommender feedback → decide laptop vs cloud → decide whether Emily can join the group → first real booking for Wed 14 Oct.

1. Phase 3c rerun: `git pull`, top up Twilio, optionally add `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` to `.env`. Check: calls only after "call"/"yes"; outcome questions; "live music" and "new options" honest; no dessert places. Then Advait shares his own notes.
2. Earlier plan for 3c: Advait runs the WhatsApp solo beta with `BOOKING_ONLY=phone`, `CALL_LANGUAGE=en`, `DRY_RUN=1`. Plan, pick, take the call as the restaurant, then try "book the time they offered" and "cancel it" (both call him again). Remove the mock reservation afterwards, or its reminders will fire.
2. Same run also checks the WhatsApp solo beta (`git pull`, `npm install`, `npm start`). Check:
   - the options cards' formatting;
   - "anything Indian?" widens instead of giving up;
   - the status line shows what the bot is doing;
   - picking an option triggers the booking order (site, then email, then phone) in dry run.
3. Implement TableCheck's newer step-by-step flow. Most TableCheck places near home use it; the flow is mapped in REQUIREMENTS §7.
4. Then add Emily, then deploy to the VM.

## Advait's preferences (don't make him repeat these)

- **Time window:** up to 30 min later than asked is fine without checking; anything else, ask in WhatsApp. A range they give in chat ("6 to 7:30") applies to that date night.
- **Phone bookings under Emily (エミリー)**; sites keep Advait's full name.
- **Calls are tightly controlled.** Never phone a restaurant without a human go-ahead in the chat, including retries and call-backs. After each call, report the outcome and propose the next step as a question.
- **Never book a place nobody picked.** If the chosen place fails, ask.
- **Be honest about misses.** Never say options match a wish ("live music") unless they do.

- **Design matters** ("a big sucker for good design"): rich WhatsApp formatting, short lines, blank lines between items, cards for options. **No em dashes, ever** (he called them out as an AI tell).
- **Seats only, never set courses**, never prepayment or a card.
- **Pick the place first, then book.** No availability gate on recommendations.
- **Booking order:** booking sites, then email, then an AI phone call (fastest and most predictable first).
- **Reply in words or with a number;** no polls by default.
- **Plan on the weekend** for the following Wednesday (Sat kickoff). Mondays are too late.
- **Keep costs down:** Anthropic API is the only paid service. Free Google Cloud VM rather than Fly.io. One Anthropic key, reused everywhere.
- **Privacy:** debug on the laptop, not by linking his WhatsApp to a cloud session. Long-term, the bot may get its own number (povo eSIM plus WhatsApp Business).
- **Wants to see progress:** a short phrase for what the bot is doing, plus ⏳/✅ reactions.
- **Do things in the sequence he asks,** one phase at a time, not in parallel.
- **Personal details** (name Advait Alai, アドヴァイト アライ, 070 number, Gmail) live only in `.env`. The repo is public.

## Environment and gotchas learned

- **Laptop setup:** `.env` has the Anthropic, Google Maps and booking details, plus `WA_SELF_MODE=1`, `WA_GROUP_JID=<solo group id>`, `WA_SOLO=1`, `DRY_RUN=1`.
  - `npm install` rewrites `package-lock.json` on his Mac. If `git pull` complains, run `git checkout -- package-lock.json` first.
- **WhatsApp "Message yourself" chat:** Baileys fails to decrypt later messages there (`Bad MAC`). Use a solo group instead.
- **Emily in the group (fixed 12 Oct):** senders were matched by exact phone digits, so `EMILY_PHONE=+8109…` never matched WhatsApp's `819…`, and LID senders never matched at all. Now: numbers normalised, `participantPn` checked, and in the two-person group anyone who isn't Advait is Emily. `WA_DEDICATED=1` (default): no "planner" keyword needed.
- **TableCheck dry-run check (12 Oct, from the cloud):** h:armonia Wed 14 Oct 18:30 reached the confirmation page. A fake test phone (070-0000-0000) makes TableCheck say "Phone is invalid / Your selected time is unavailable", which looks like "full". Use a valid-looking number in tests.
- **Harmless log noise:** Baileys `init queries` timeouts, "Invalid mex newsletter notification", and Bad MAC / "failed to decrypt" for backlog from other chats after a restart. Hidden by default since 11 Oct; `WA_LOG_LEVEL=warn` shows them. The group list only prints when `WA_GROUP_JID` is unset (it listed all of Advait's groups in the terminal).
- **Old plans fire their jobs on startup.** A plan proposed in an earlier beta run keeps its Sunday nudge and decide jobs. Stale nudges (over 2h late) are now dropped; "decide" still runs. Say "skip this week" or plan again to move on.
- `npm install` reports 2 high vulnerabilities in link-preview-js (via Baileys). No fix upstream. Low risk (only previews links the bot sends). Recheck before the VM deploy; option: turn off link previews.
- **Cloud sessions:**
  - Tabelog shows a Cloudflare bot check, so it can't be used from there.
  - The auto-mode safety check blocks real bookings. Use Accept-edits mode and let Advait approve the command.
  - Chromium needs the proxy CA in `~/.pki/nssdb` (see REQUIREMENTS §7).
- **TableCheck:**
  - Availability API: send `start_at` as the JST date and time; it returns about 9 slots around it.
  - Search results carry names in `text_translations`.
  - The success page says "Reservation is **Accepted**".
  - The availability API can say free while the form refuses ("selected time is unavailable").
- **Vapi:**
  - Free numbers are US-only, so a Twilio number is needed for Japan.
  - Model `claude-sonnet-5` (from Vapi's Anthropic list), Deepgram `nova-2` with `ja`, ElevenLabs `eleven_multilingual_v2`.
  - Restaurants may ignore +1 numbers; a Japanese number is in the backlog.
  - Twilio's "add an emergency address" banner can be ignored: the $75 fee only applies to 911 calls from that number.
  - Use the **private** Vapi key. The phone number **ID** (UUID) is on the number's page in Vapi.
  - `CALL_TEST_TO=Emily` (or `npm run test-call -- ja emily`) sends dry-run calls to Emily instead of Advait. Trial accounts need her number verified in Twilio first.
  - Twilio Japan rates (twilio.com/voice/pricing/jp, Oct 2026): about $0.19/min to mobiles, $0.07/min to landlines, plus Vapi's own per-minute cost. A $2–3 balance lasted about 8 short test calls (to a mobile).
  - `call.start.error-get-transport` = Vapi couldn't place the call through Twilio (here: credit ran out).
  - TTS read "Advait Alai" as "Advait A Lie". Since 12 Oct phone bookings go under **Emily (エミリー)** (`CALL_BOOKING_NAME`), easy for staff to write; sites keep the full name.

## Beta feedback log

- **10 Oct, round 1:**
  - Options didn't explain the places or why they were picked.
  - No sign the bot was working.
  - Follow-up questions were ignored (self-chat decryption).
  - Dry run failed (newer TableCheck flow).
  - **Fixed:** status line, ⏳/✅ reactions, `option_details` tool, solo group mode, booking-flow filter.
- **10 Oct, round 2:**
  - Formatting was one blob, with em dashes.
  - "Anything Indian?" gave up.
  - Only 12 places were checked.
  - The availability check was failing and slowed things down.
  - **Asked for:** booking order sites > email > phone, and an AI call demo.
  - **Fixed:** cards, pick first then book, widening, the booking order, and the Vapi phone adapter with a test-call script.
- **11 Oct, round 3 (full WhatsApp loop, mock calls):**
  - Worked: call loop (full with offer, wrong number, booked, cancel by phone), status lines, skip a week.
  - Broken: after Warayaki was full it called As and **booked Bruna** without asking; "book La Jolla" also called 2 other places. Claimed "live music picks" and "Mexican and Thai" when neither was true. "New options" repeated the same places. Dessert-course counter offered for dinner. h:armonia offered after they'd been. "Vote in the poll" with polls off. Double messages. Debug-style failure text. Last 4 calls failed: Twilio credit ran out ($2–3 left).
  - **Fixed:** go-ahead for every call + outcome tree (REQUIREMENTS R15a/b); book only the chosen place; must-have filters using Google's attributes; dinner-only; no repeats; honest notes and facts; `log_visit`; Twilio balance and error check (optional `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`); no poll talk; NO_REPLY after posting tools.
- **11 Oct, test call:**
  - "Perfect." The caller declined an offered 19:30 to ask for more times, then lost it.
  - **Fixed:** the script now accepts an offered time as a note and says it'll call back; offered times flow back to WhatsApp ("They offered 19:30. Book that?"). Call progress shows in the status line.
