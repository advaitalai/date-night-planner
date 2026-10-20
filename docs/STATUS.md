# Status and working notes

The running log of where the project is. **Update this at the end of every session.** It's what a new session (or a compacted one) relies on to pick up without re-asking Advait.

Last updated: 16 Oct 2026.

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

**20 Oct, descoped the Saturday trigger** (Advait): planning starts only when asked. Removed the kickoff and Sunday reminder jobs, "skip a week", their settings (`src/jobs/weekly.ts` → `reminders.ts`, keeping still-on, day-of and visit log). Leftover kickoff/nudge jobs in the database have no handler and fail quietly. **Bug found on the way (P0-2 at SMOKEHOUSE):** after "Next Step" TableCheck shows "PLEASE WAIT…" for several seconds; the bot checked after 2 s, read hidden placeholder text ("Your selected time is unavailable") as an error and reported a free table as full, while TableCheck went on to hold it (a real booking would have said "full" and left a held table). Fixed: wait up to 25 s for the review page (any-case Confirm button or the page's "Time Remaining to Confirm"), stop early on a visible error, and only read visible error text. **Verified live 20 Oct: P0-2 passes at SMOKEHOUSE** (real TableCheck dry run reached the review page, 18:30).

**20 Oct: own number.** Advait got a povo eSIM (voice plan, for the SMS code; no 5G SA), registered WhatsApp Business on it, named the bot **Concierge** and added it to the group. Code: `WA_BOT_NAME` (saying "concierge" addresses the bot, as a whole word), the "other person" fallback now works with the bot's own number, `setup-vm.sh` checks out the working branch and locks down `.env`. Next: the cloud server (SETUP §2–4), linking Concierge there directly; stop the laptop copy first.

**16 Oct, lean cut (Advait: "run a very lean product so I don't have to keep testing").** Agreed story by story (`docs/USER_STORIES.md`), then built:
- **Decisions by judgement:** either of you can decide, in any words; the bot asks "Shall I book X?" when unsure. No vote counting, no Sunday auto-book.
- **Addressing:** the bot answers only inline replies to its messages or "planner". Everything else it just listens to, and only speaks up to confirm a decision it heard ("Sounds like X. Shall I book it?", once per option). `WA_DEDICATED` is gone.
- **Calls:** deciding on a phone-only place = go-ahead, it calls straight away. Other calls (cancel, change, retry) ask, and any clear yes counts (no "call" keyword). No calls scheduled for later; closed → "they open at 17:00, reply when you'd like me to call".
- **Cut:** email and Tabelog booking, Gmail/Drive watchers, onboarding web page, polls, auto-cancel, the 48h "still on?", the detailed call outcome tree, the `recent_calls` tool. `fastify` and `googleapis` removed.
- **Kept:** changing a booking, the visit log, the policy lookup, one "still on?" a day before the free-cancel deadline.
- **Tests:** 90 unit tests pass (new: who the bot answers, listening and confirming, calling on a decision, closed restaurant, one reminder). P0 updated: P0-5 = decide on a phone-only place → one call; cancel asks; "ok go ahead" → one call. P0-7 = they talk it over, bot confirms, books on "yes please" (needs the agent). Tools-mode run in the cloud: P0-3, 4, 5 ✅; P0-2 found no free table (slot held by the earlier run), not a code change.
- **Laptop P0 run through the agent (16 Oct): P0-1..7 all pass.** Next: use it for real (Emily replies inline). **Then: give the bot its own WhatsApp number** (agreed 16 Oct; steps in SETUP §4).

**12 Oct, P0 session (cloud):** the Anthropic key didn't reach the shell (neither `ANTHROPIC_API_KEY` nor `PLANNER_ANTHROPIC_API_KEY`), so only the no-LLM checks ran.
- Built `npm run p0` (see `docs/P0_TESTS.md`). `--tools` run: **P0-2, 3, 4, 5, 7 pass**, with a real TableCheck dry run (SMOKEHOUSE, Wed 14 Oct 18:30, stopped at TableCheck's confirmation page). **P0-1 and P0-6 not run** (need the agent).
- Fixed on the way:
  - Seat-only detection missed plain table bookings ("Book a Table", "Dining Table", "Bar Counter"), so places like bills and SMOKEHOUSE counted as "courses only".
  - A TableCheck 403 page was read as "seat-only form" and cached for a week. 403s now retry and are never cached.
  - New TableCheck layout: date + time dropdowns instead of the grid (SMOKEHOUSE). Now booked in dry run, incl. a required checkbox question.
  - "Selected time is unavailable" next to other form errors no longer means "full".
  - The dry-run booking message now says when it moved the time inside the window (P0-4).
  - "Full" message lists nearby dinner times, not every slot (it offered lunch times).
  - Dessert filter: `cake_shop`, `pastry_shop`. Detection skips TableCheck pickup slugs.
  - `PLANNER_ANTHROPIC_API_KEY` always goes to api.anthropic.com (the sandbox's own `ANTHROPIC_BASE_URL` must not get it).
- Of the 15 TableCheck places on the saved list, the bot can book 2 (SMOKEHOUSE, bills Omotesando); 6 use the newer flow, the rest are courses only or need a card. Discovery near home adds more.
- **Every TableCheck dry run holds a real table for 10 minutes.** Repeated dry runs on one slot make it look full and block a real table, so keep them few.
- **Next:** rerun with the key (`npm run p0`), for P0-1/P0-6 and the agent-level P0-2..7. Then the launch checklist.

**12 Oct, laptop P0 run (agent):** P0-1 ✅, P0-4 ✅. P0-2/3/5/7 crashed in the test script (fixtures: a fresh import has no phone-only or TableCheck places yet, since channel detection is lazy). P0-6 flagged a false fail: the bot found Mexican places with live music 35 min away and said so; the test assumed none existed. Fixed both in the script (P0-6 now checks claims against the data); area names fixed for Japan-first addresses ("Tokyo" was shown). Cloud tools-mode rerun: P0-2/3/4/5/7 ✅ (real TableCheck dry run, SMOKEHOUSE). Next: Advait reruns `npm run p0` on the laptop.

**16 Oct, retro of 12–15 Oct (Advait's `npm run retro`):** 102 messages (Emily 7), 9 proposals, 2 bookings (both phone, both cancelled), 5 calls (4.4 min, $0.36), 146 WhatsApp reconnects, 85 skipped synced messages. New bugs found in the data and fixed: (1) re-asking a scheduled call for the same place and time was silently dropped as a duplicate, so the old slot (18:30) was called instead of 19:15; (2) a new time now replaces the earlier scheduled call; (3) the day-of reminder went out twice (retry after a send timeout): message and call jobs no longer retry; (4) a temporarily closed place was offered: Google `businessStatus` now filters; (5) single-instance lock (`data/bot.pid`) in case two copies were fighting over the WhatsApp login (a likely cause of the reconnect storm); pid now in log lines. Requirements vs tests: `docs/QA_MAP.md`, with P0-11..18 regression cases to add.

**14 Oct, later: working again.** WhatsApp had stopped delivering group messages to the linked bot (connected, but no `[wa]`/`[in]` lines). Fixed by connecting as the current WhatsApp Web version (`fetchLatestWaWebVersion`) plus a fresh re-link (`rm -rf data/wa-auth`, log out old linked devices). Also: recent synced ("append") group messages are now answered once.

**To deep-dive next session (Advait's ask):** the whole WhatsApp reliability story (Bad MAC, missed messages, reconnect crashes) and whether to move the bot to its own number; the Suan Sawan duplicate (confirm cleaned up, mark with "I cancelled it myself"); quiet the Signal decrypt noise that still prints at startup; off-topic policy; Japanese caller number; VM deployment; strict picks (number/name only).

**14 Oct, first live use: incidents.**
- **A dropped call still happened.** A call was scheduled for 14:30; Advait said to drop it; `decline_call` only cleared the *proposed* call, not the *scheduled* job, so at 14:30 the bot phoned Suan Sawan Gotanda and booked Thu 15 Oct 19:15 under Emily, possibly a duplicate of a booking Advait had. The bot had also told him it was dropped. **Fixed:** dropping a call cancels scheduled ones too (`dropAllCalls`); a scheduled booking call re-checks for an existing booking that date and asks instead; "don't call / cancel the call" can never count as a go-ahead; `say don't call to stop it` shown when scheduling; scheduled calls listed in the bot's state.
- **The app crashed** on a WhatsApp timeout while listing groups at reconnect. **Fixed:** caught, plus a process-wide handler so background errors never kill the bot.
- **"Recap this call"** couldn't see the transcript. **Added** `recent_calls` tool (reads `call_log`).
- WhatsApp re-link was needed once (Bad MAC after Emily joined); `npm run fresh-start` cleared test leftovers (incl. a test "skip Wed 14 Oct").

**12 Oct, evening: launching.** All P0-1..7 pass on the laptop (P0-5 after the "bare call = now" fix). Japanese test call to Advait: second try booked fine (outcome read correctly); the first hung up after the greeting because 失礼いたします was both in the greeting and an end-call phrase (fixed). Twilio is a paid account, so phone-only places are fine (each call still needs a yes). Next: production `.env` (still dry run), add Emily to the renamed test group, live checks P0-8/9, then `DRY_RUN=0` and the real Wednesday booking (P0-10). Open: off-topic questions policy (suggested: one-line answer, then back to date night); Japanese caller number in Twilio; Japanese-native voice; move to the VM after Wednesday.

**12 Oct, laptop P0 rerun (agent):** P0-1, 2, 3, 4, 6, 7 ✅. P0-5 ❌: run at 21:42 with the place closed; the ask offered "call at 11:30 / call now / no", the reply "call" was taken as ambiguous and no call happened. Fixed: a bare "call"/"yes" means call now (ask wording and place_call rules). Rerun `npm run p0 -- P0-5`.

**Handoff for the next session (12 Oct):** Advait is starting a new cloud session with `ANTHROPIC_API_KEY` so Claude can run the P0 tests itself. Do this, in order:
1. Read this file, `docs/P0_TESTS.md` and `docs/USER_STORIES.md`.
1a. The key: in Claude Code cloud sessions `ANTHROPIC_API_KEY` from the environment doesn't reach the shell (reserved for Claude Code). Store it as `PLANNER_ANTHROPIC_API_KEY`; `src/llm.ts` reads either.
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
- **Calls need a go-ahead, read like a person would** (16 Oct): deciding on a phone-only place counts; otherwise ask, and any clear yes counts. "No" stops it. No calls scheduled for later. After each call, report what happened and ask what next.
- **Either of us can decide** (16 Oct). An opinion isn't a decision; when unsure, ask. Don't make us both pick the same number.
- **Only answer what's addressed to the bot** (inline reply or "planner"); everything else is us talking.
- **Lean product** (16 Oct): fewer features, fewer things to test. Prefer the agent's judgement over rigid parsing rules ("you're being a dialogue parser rather than an LLM").
- **Never book a place nobody picked.** If the chosen place fails, ask.
- **Be honest about misses.** Never say options match a wish ("live music") unless they do.

- **Design matters** ("a big sucker for good design"): rich WhatsApp formatting, short lines, blank lines between items, cards for options. **No em dashes, ever** (he called them out as an AI tell).
- **Seats only, never set courses**, never prepayment or a card.
- **Pick the place first, then book.** No availability gate on recommendations.
- **Booking order:** TableCheck, then an AI phone call (email and Tabelog cut 16 Oct).
- **Reply in words or with a number;** no polls.
- **Plan on the weekend** for the following Wednesday (Sat kickoff). Mondays are too late.
- **Keep costs down:** Anthropic API is the only paid service. Free Google Cloud VM rather than Fly.io. One Anthropic key, reused everywhere.
- **Privacy:** debug on the laptop, not by linking his WhatsApp to a cloud session. **The bot gets its own number next** (agreed 16 Oct; e.g. povo eSIM plus WhatsApp Business).
- **Wants to see progress:** a short phrase for what the bot is doing, plus ⏳/✅ reactions.
- **Do things in the sequence he asks,** one phase at a time, not in parallel.
- **Personal details** (name Advait Alai, アドヴァイト アライ, 070 number, Gmail) live only in `.env`. The repo is public.

## Environment and gotchas learned

- **Laptop setup:** `.env` has the Anthropic, Google Maps and booking details, plus `WA_SELF_MODE=1`, `WA_GROUP_JID=<solo group id>`, `WA_SOLO=1`, `DRY_RUN=1`.
  - `npm install` rewrites `package-lock.json` on his Mac. If `git pull` complains, run `git checkout -- package-lock.json` first.
- **WhatsApp "Message yourself" chat:** Baileys fails to decrypt later messages there (`Bad MAC`). Use a solo group instead.
- **Emily in the group (fixed 12 Oct):** senders were matched by exact phone digits, so `EMILY_PHONE=+8109…` never matched WhatsApp's `819…`, and LID senders never matched at all. Now: numbers normalised, `participantPn` checked, and in the two-person group anyone who isn't Advait is Emily. (`WA_DEDICATED` was removed 16 Oct: the bot now answers inline replies and "planner" only.)
- **Anthropic key in cloud sessions (12 Oct):** neither `ANTHROPIC_API_KEY` nor `PLANNER_ANTHROPIC_API_KEY` reached the shell in the P0 session. Check that it's saved in the environment's settings (and that a new session was started after saving it).
- **TableCheck from the cloud sandbox:** 403s after ~50 requests in a few minutes; clears after a minute or two.
- **TableCheck dry-run check (12 Oct, from the cloud):** h:armonia Wed 14 Oct 18:30 reached the confirmation page. A fake test phone (070-0000-0000) makes TableCheck say "Phone is invalid / Your selected time is unavailable", which looks like "full". Use a valid-looking number in tests.
- **Harmless log noise:** Baileys `init queries` timeouts, "Invalid mex newsletter notification", and Bad MAC / "failed to decrypt" for backlog from other chats after a restart. Hidden by default since 11 Oct; `WA_LOG_LEVEL=warn` shows them. The group list only prints when `WA_GROUP_JID` is unset (it listed all of Advait's groups in the terminal).
- **Old plans fire their jobs on startup.** A plan proposed in an earlier beta run keeps its Sunday nudge. Stale nudges (over 2h late) are dropped. (The "decide" auto-book is gone since 16 Oct; old "decide" jobs in the database have no handler and just fail quietly.)
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
