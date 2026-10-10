# Status and working notes

The running log of where the project is. **Update this at the end of every session.** It's what a new session (or a compacted one) relies on to pick up without re-asking Advait.

Last updated: 10 Oct 2026.

## Where we are

| Phase | State |
|---|---|
| 1. Simulated chat (no code) | ✅ Done 7 Oct. Advait approved the flow. |
| 2. Real booking by chatting with Claude | ✅ Done 7 Oct. **h:armonia, Fri 9 Oct 18:00, 2 people, seats only**, booked via TableCheck and kept. The first real booking (MVP success event). |
| 3. WhatsApp beta (solo, Advait only) | 🔄 In progress. Running on Advait's laptop in a WhatsApp group that has only him in it (`WA_SOLO=1`). First two beta rounds gave feedback (below), and the fixes are pushed. Next round not yet run. |
| 3b. AI phone calls | 🔄 Built (`src/booking/phone.ts`, `npm run test-call`). Not yet tried live: Advait needs a Vapi account and a Twilio number (docs/SETUP.md §7). |
| 4. Add Emily to the group | ⏳ Only after Advait has vetted the solo flow. Don't bother Emily until it works. |
| 5. Always-on server (Google Cloud e2-micro) | ⏳ After the beta. |

## Next steps

1. Advait sets up Vapi and Twilio, runs `npm run test-call`, and shares the transcript and outcome. Tune the call script and voice from that.
2. Advait reruns the WhatsApp solo beta (`git pull`, `npm install`, `npm start`). Check:
   - the options cards' formatting;
   - "anything Indian?" widens instead of giving up;
   - the status line shows what the bot is doing;
   - picking an option triggers the booking order (site, then email, then phone) in dry run.
3. Implement TableCheck's newer step-by-step flow. Most TableCheck places near home use it; the flow is mapped in REQUIREMENTS §7.
4. Then add Emily, then deploy to the VM.

## Advait's preferences (don't make him repeat these)

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
- **Harmless log noise:** Baileys `init queries` timeouts.
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
