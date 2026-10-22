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
   - Boot disk: the default (Debian 13) is fine, *Standard persistent disk*, 30 GB
   - Everything else default. No need to allow HTTP/HTTPS, because nothing needs to be public.
2. Once it's running, click **SSH** to open a terminal in the browser, then run:
   ```
   sudo apt-get update && sudo apt-get install -y git
   git clone -b claude/festive-volta-e3nm17 https://github.com/advaitalai/date-night-planner.git && bash date-night-planner/deploy/setup-vm.sh
   ```
   `main` only has the README until the working branch is merged, so clone the branch (`-b`); after the merge, plain `git clone` and `BRANCH=main`.
3. Edit the config with `nano ~/date-night-planner/.env`. Fill in the keys from steps 1–2 and your booking details:
   ```
   BOOKING_NAME=<your name>
   BOOKING_NAME_KANA=<your name in katakana>
   BOOKING_PHONE=<your mobile, e.g. 070-…>
   BOOKING_EMAIL=<your email>
   ```
   Keep `DRY_RUN=1` for now.

**Updating later:** `cd ~/date-night-planner && bash deploy/update.sh`. It pulls the latest code, reinstalls libraries only if their list changed (`npm ci --omit=dev`), and restarts the service if it's running. Don't run plain `npm install` on the server: it adds developer tools and can rewrite `package-lock.json`.

**From your phone (Termius):**
1. In Termius, generate an ed25519 key and copy its public key.
2. In the browser SSH window, add it to `authorized_keys2`, not `authorized_keys`. Google's guest agent rewrites `authorized_keys` and wipes keys it didn't add.
   ```
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   echo '<the public key>' >> ~/.ssh/authorized_keys2
   chmod 600 ~/.ssh/authorized_keys2
   ```
3. Still in the browser window, let the update script restart the bot without a password (your account has none; only the browser SSH gets passwordless sudo):
   ```
   echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart date-night-planner" | sudo tee /etc/sudoers.d/date-night && sudo chmod 440 /etc/sudoers.d/date-night && sudo visudo -c
   ```
4. Add a host in Termius: the VM's external IP, your Google username, that key.
5. Save snippets:
   - **Update bot:** `cd ~/date-night-planner && bash deploy/update.sh`
   - **Bot status:** `journalctl -u date-night-planner -n 15 --no-pager`

## 4. Connect WhatsApp (no spare SIM needed)

By default (`WA_SELF_MODE=1`) the bot links to **your own WhatsApp** as a linked device, the same way WhatsApp Web does.

1. On the VM, run `cd ~/date-night-planner && npm start`. A QR code appears.
2. On your phone, go to **WhatsApp → Settings → Linked devices → Link a device** and scan it.
3. The log lists your groups. Make a group with Emily (e.g. "Date night 🍷"), restart, copy that group's id into `WA_GROUP_JID`, and restart again.
4. Press Ctrl+C, then start it as a service with `sudo systemctl enable --now date-night-planner`. To watch the logs: `journalctl -u date-night-planner -f`. Keep it as a service even while testing: `npm start` in an SSH window stops when the window disconnects.

**How this mode works:**
- The bot's messages appear as you, starting with 🤖.
- Talk to it like a third person in the group: it judges which messages are meant for it. Replying inline (swipe right) or using its name always counts. When you two settle on an option between yourselves, it asks before booking ("Sounds like X. Shall I book it?").

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
2. Unzip it, upload the CSV to the server, stop the bot, and run `npm run import-csv -- "<file>.csv" Emily "<list name>"` (or `Advait`), once per list. Each new place gets two cheap Google lookups (within the free monthly allowance); only **dinner places within reach of home or work** are kept, and it prints what was added and skipped. Full details (hours, phone, live music) are fetched later, only for places that come up near a date. Never commit the CSV (the repo is public).

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

## 10. Server logs for Claude (read-only)

On the Google Cloud VM the bot also sends its log lines to **Cloud Logging** in your project (log name `date-night-planner`), every 30 seconds, using the VM's own credentials. Nothing to install; `CLOUD_LOGGING=0` turns it off. Claude reads them with a key that can only view logs: no access to the server itself.

1. **Let the VM write logs.** Cloud console → **IAM & Admin → IAM** → find *Compute Engine default service account* → edit → add the role **Logs Writer** (skip if it already has *Editor*).
2. **Make the read-only key.** **IAM & Admin → Service accounts → Create service account**: name `log-reader`, role **Logs Viewer** only, Done. Open it → **Keys → Add key → Create new key → JSON**. A file downloads.
3. **Give it to Claude's environment, not the chat.** The environment variables box takes one line per variable, so turn the key into one line first (Mac): `base64 -i ~/Downloads/<key>.json | tr -d '\n' | pbcopy`. Then in the Claude Code cloud session: the environment menu in the session's title bar → **Edit** → **Environment variables** (not the setup script) → add `GCP_LOG_READER_KEY=<paste>`. Start a new session to pick it up. Then delete the downloaded file.
4. **On the server:** `bash deploy/update.sh`. The log shows `Sending logs to Cloud Logging (project …)`.

To revoke: delete the key (or the `log-reader` account) in the console.

How Claude reads them (for future sessions):
```
# The key is base64 (one line) or raw JSON.
(echo "$GCP_LOG_READER_KEY" | base64 -d 2>/dev/null || echo "$GCP_LOG_READER_KEY") > /tmp/log-reader.json
gcloud auth activate-service-account --key-file=/tmp/log-reader.json
# Cloud sessions set CLOUDSDK_AUTH_ACCESS_TOKEN, which overrides the key: unset it.
env -u CLOUDSDK_AUTH_ACCESS_TOKEN gcloud logging read 'logName="projects/<project>/logs/date-night-planner" AND timestamp>="2026-10-20T12:00:00Z"' --project <project> --order=asc --format='value(timestamp,textPayload)' --limit 2000
```
(`<project>` is `project_id` in the key.) Every call's outcome and transcript are in the log too (`[call]` lines).

