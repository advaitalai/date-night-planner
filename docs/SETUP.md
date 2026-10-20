# Setup guide

Everything runs on Google Cloud's always-free tier. The only paid service is the Anthropic API, which costs a few dollars a month (see the cost estimate in step 1).

## 1. Anthropic API key

1. Go to **console.anthropic.com** and sign up. A claude.ai Pro/Max subscription doesn't cover API use; the API is billed separately.
2. **Settings → Billing**: buy prepaid credits. The minimum is $5. You can leave auto-reload off so you can't overspend.
3. **API Keys → Create Key**, then copy it into `ANTHROPIC_API_KEY`.

**Rough cost estimate (not measured yet):**
- About $1, once, to build profiles for your saved places.
- After that, a few dollars a month on `claude-opus-5-5`.
- Set `CLAUDE_MODEL=claude-sonnet-5-5` to roughly halve that.

## 2. Google Cloud project

Do all of this in **console.cloud.google.com** while signed in as advaitalai@gmail.com.

1. **Create a project.** Use the project picker at the top, choose **New project** and name it `date-night-planner`.
2. **Turn on billing.** Go to **Billing** and link a billing account. This needs a card even though we stay in the free tier.
3. **Set a budget alert.** Go to **Billing → Budgets & alerts → Create budget**, set ¥500/month and alert at 50/90/100%.
4. **Enable the APIs.** Go to **APIs & Services → Library** and enable each of these:
   - Places API (New)
   - Routes API
   - Compute Engine API
5. **Create the Maps API key.**
   - Go to **APIs & Services → Credentials → Create credentials → API key**.
   - Edit the key: under *API restrictions* choose **Restrict key** and tick **Places API (New)** and **Routes API**.
   - Put it in `GOOGLE_MAPS_API_KEY`.
6. **Optional: cap the Maps usage.** Go to **APIs & Services → Places API (New) → Quotas** and lower the per-day request limits (e.g. 200/day). The bot uses far less than Google's free monthly allowance, so this is just a safety net.
## 3. The server: a free e2-micro VM

The bot has to run all the time, to stay connected to WhatsApp and send the reminders on time. Google's always-free tier includes one small VM, but only in some US regions. That's fine for this: the bot mostly waits.

1. Go to **Compute Engine → VM instances → Create instance** and set:
   - Name `date-night`
   - Region **us-west1** (Oregon), any zone
   - Machine type **e2-micro**
   - Boot disk: **Ubuntu 24.04 LTS**, *Standard persistent disk*, 30 GB
   - Everything else default. No need to allow HTTP/HTTPS, because nothing needs to be public.
2. Once it's running, click **SSH** to open a terminal in the browser, then run:
   ```
   sudo apt-get update && sudo apt-get install -y git
   git clone https://github.com/advaitalai/date-night-planner.git && bash date-night-planner/deploy/setup-vm.sh
   ```
   It runs the working branch (`claude/festive-volta-e3nm17`) until that's merged; `BRANCH=main` after.
3. Edit the config with `nano ~/date-night-planner/.env`. Fill in the keys from steps 1–2 and your booking details:
   ```
   BOOKING_NAME=Advait
   BOOKING_NAME_KANA=アドヴァイト
   BOOKING_PHONE=070-1568-0178
   BOOKING_EMAIL=advaitalai@gmail.com
   ```
   Keep `DRY_RUN=1` for now.

## 4. Connect WhatsApp (no spare SIM needed)

By default (`WA_SELF_MODE=1`) the bot links to **your own WhatsApp** as a linked device, the same way WhatsApp Web does.

1. On the VM, run `cd ~/date-night-planner && npm start`. A QR code appears.
2. On your phone, go to **WhatsApp → Settings → Linked devices → Link a device** and scan it.
3. The log lists your groups. Make a group with Emily (e.g. "Date night 🍷"), restart, copy that group's id into `WA_GROUP_JID`, and restart again.
4. Press Ctrl+C, then start it as a service with `sudo systemctl enable --now date-night-planner`. To watch the logs: `journalctl -u date-night-planner -f`.

**How this mode works:**
- The bot's messages appear as you, starting with 🤖.
- Talk to it by **replying inline to one of its messages** (swipe right on it), or by including "planner". Everything else is you two talking: the bot only listens, and speaks up just to confirm a decision it heard ("Sounds like X. Shall I book it?").

**Risk:** it's an unofficial WhatsApp library, and in this mode it runs on your own number. WhatsApp rarely bans low-volume use like this, but the risk isn't zero.

**To use a separate number instead (planned, agreed 16 Oct):** this is the fix for the linked-device outages of 12–15 Oct (Bad MAC, missed messages), and @mentions of the bot start working.
1. Get a free-to-hold Japanese eSIM, e.g. **povo 2.0**. Its base plan is ¥0; you top up occasionally to keep the number alive.
2. Install **WhatsApp Business** on the same phone and register it with that number. Give it a name and photo (e.g. "Planner 🍷").
3. Add it to the group with Emily.
4. On your own phone: **WhatsApp → Settings → Linked devices**, log out the old bot device. Then `rm -rf data/wa-auth`.
5. `.env`: `WA_SELF_MODE=0`, `WA_BOT_NAME=<its WhatsApp name, e.g. Concierge>`, and `ADVAIT_PHONE` / `EMILY_PHONE` set (in this mode they're how the bot tells you apart; once one of you is recognised, the other unknown sender is the other person).
6. `npm start` and scan the QR **with the WhatsApp Business app** (its Linked devices).
7. Bot messages now come from the bot's own name, without the 🤖 prefix. Talk to it by replying inline, saying its name ("concierge") or "planner", or @mentioning it.

## 5. Saved places

Import each person's saved Google Maps places from a Takeout export (a couple of times a year):
1. **takeout.google.com** → deselect all → tick **Saved** → export once, download the zip.
2. Unzip it and run `npm run import-csv -- "<file>.csv" Advait` (or `Emily`), once per list.
3. A Google Maps link pasted into the chat is added straight away.

## 6. Booking-site logins

- **TableCheck:** nothing to do. The bot books as a guest using your name, phone and email, and TableCheck emails the confirmation and the change/cancel link to your Gmail.
- Places with only Tabelog or email booking are booked by phone (Tabelog and email booking were cut on 16 Oct).

## 7. AI phone calls (for places without TableCheck)

1. Sign up at **vapi.ai**. Dashboard → **API Keys** → copy the private key into `VAPI_API_KEY`.
2. Vapi's free numbers only call the US, so calls to Japan need a **Twilio** number:
   - Sign up at **twilio.com**. A trial account works for testing, but it can only call numbers you verify (add your own mobile under *Verified Caller IDs*) and plays a short "trial account" notice first.
   - Buy a number (a US number is the simplest; a Japanese number needs address verification).
   - Twilio Console → Voice → Settings → **Geo permissions** → enable **Japan**.
3. In Vapi: **Phone Numbers → Import → Twilio**, enter the Account SID, Auth Token and the number. Copy the new number's **ID** into `VAPI_PHONE_NUMBER_ID`.
4. Test with a call to yourself (you play the restaurant): `npm run test-call` (Japanese) or `npm run test-call -- en`.
   - Someone else can play the restaurant: `npm run test-call -- ja emily` calls `EMILY_PHONE`. For the WhatsApp flow, set `CALL_TEST_TO=Emily`.
   - On a Twilio trial, add their number under **Verified Caller IDs** first (they get a code by call or SMS), or upgrade the account.

With `DRY_RUN=1` every booking call goes to `BOOKING_PHONE` (you) instead of the restaurant.

**End-to-end test from WhatsApp:** add `BOOKING_ONLY=phone` and `CALL_LANGUAGE=en` to `.env`, keep `DRY_RUN=1`, and run `npm start`. Every booking then becomes an AI call to you. Remove `BOOKING_ONLY` afterwards. Costs are per minute on both Vapi and Twilio; check their pricing pages.

## 8. Check and go live

1. Run `npm run import-csv -- fixtures/Tokyo_food.csv Advait "Tokyo food"`, then `npm run audit`. Read `audit-report.md` to see how your saved places can be booked.
2. In the group, say "planner plan next Wednesday". Check that the options look right, reply to them with a number, and check that the dry-run booking reaches the confirm step.
3. When happy, set `DRY_RUN=0` and restart: `sudo systemctl restart date-night-planner`.

## 9. Launch checklist (first real booking with Emily)

1. `git pull`, `npm install`.
2. `.env`:
   - `DRY_RUN=0`
   - remove `BOOKING_ONLY`, `CALL_TEST_TO`; `CALL_LANGUAGE=ja`
   - `WA_SOLO=0`, `WA_GROUP_JID=<the group with Emily>`
   - `ADVAIT_PHONE`, `EMILY_PHONE` set (any format)
   - optional `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (balance check)
3. Phone calls to restaurants need an upgraded Twilio account (trial accounts only call verified numbers and play a trial notice). Until then, pick places bookable on TableCheck.
4. Tell Emily: bot messages show as Advait with 🤖; to talk to the bot, reply inline to its message (or say "planner"); either of you can decide on an option; calls book under her name (エミリー); messages in the group are read by Claude.
5. `npm start`, check the log says `Listening in "<group>"`, say hi.
