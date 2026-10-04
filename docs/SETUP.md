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
   - Gmail API
   - Google Drive API
   - Compute Engine API
5. **Create the Maps API key.**
   - Go to **APIs & Services → Credentials → Create credentials → API key**.
   - Edit the key: under *API restrictions* choose **Restrict key** and tick **Places API (New)** and **Routes API**.
   - Put it in `GOOGLE_MAPS_API_KEY`.
6. **Optional: cap the Maps usage.** Go to **APIs & Services → Places API (New) → Quotas** and lower the per-day request limits (e.g. 200/day). The bot uses far less than Google's free monthly allowance, so this is just a safety net.
7. **Set up the OAuth consent screen.** Go to **Google Auth Platform** (or **APIs & Services → OAuth consent screen**):
   - App name `Date Night Planner`, user type **External**, your email as the support and developer contact.
   - **Audience → Publish app** to set it to *In production*. In *Testing*, logins expire every 7 days.
   - Google will show you and Emily an "unverified app" warning once when you sign in. That's expected for a private app; click *Advanced → Go to Date Night Planner*.
8. **Create the OAuth client.**
   - Go to **Credentials → Create credentials → OAuth client ID → Web application**.
   - Add the authorized redirect URI `http://localhost:8080/oauth/callback`.
   - Put the client ID and secret in `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

## 3. The server: a free e2-micro VM

The bot has to run all the time, to stay connected to WhatsApp, fire the Saturday and deadline timers, and watch Gmail. Google's always-free tier includes one small VM, but only in some US regions. That's fine for this: the bot mostly waits.

1. Go to **Compute Engine → VM instances → Create instance** and set:
   - Name `date-night`
   - Region **us-west1** (Oregon), any zone
   - Machine type **e2-micro**
   - Boot disk: **Ubuntu 24.04 LTS**, *Standard persistent disk*, 30 GB
   - Everything else default. No need to allow HTTP/HTTPS, because nothing needs to be public.
2. Once it's running, click **SSH** to open a terminal in the browser, then run:
   ```
   curl -fsSL https://raw.githubusercontent.com/advaitalai/date-night-planner/main/deploy/setup-vm.sh | bash
   ```
   Until the code is merged to `main`, clone the branch and run `bash deploy/setup-vm.sh` instead.
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
- Talk to it by including "planner" in a message, or by replying to one of its messages.

**Risk:** it's an unofficial WhatsApp library, and in this mode it runs on your own number. WhatsApp rarely bans low-volume use like this, but the risk isn't zero.

**To use a separate number instead:**
1. Get a free-to-hold Japanese eSIM, e.g. **povo 2.0**. Its base plan is ¥0; you top up occasionally to keep the number alive.
2. Install **WhatsApp Business** on the same phone and register it with that number.
3. Add it to the group.
4. Set `WA_SELF_MODE=0` and link that account instead.

## 5. Connect Google (Gmail, Drive) for you and Emily

The setup page is only reachable through an SSH tunnel from your laptop, so nothing is exposed to the internet.

1. On your laptop, install the gcloud CLI and run:
   ```
   gcloud compute ssh date-night --zone <your zone> -- -L 8080:localhost:8080
   ```
2. In the WhatsApp group, send "planner setup". The bot replies with one link per person.
3. Open your link in your laptop browser and click **Connect Google**.
4. Have Emily open her link **on your laptop** while the tunnel is open, and sign in with her Google account. Her link only asks for Drive.
5. Each of you then does the one-time Takeout export described on the page: *Saved* only, delivered to Drive, every 2 months.

## 6. Booking-site logins

- **TableCheck:** nothing to do. The bot books as a guest using your name, phone and email, and TableCheck emails the confirmation and the change/cancel link to your Gmail.
- **Tabelog:** online booking needs a Tabelog login, and yours uses Google sign-in, which the bot can't type itself. Log in once by hand:
  1. On your laptop (Google Chrome installed), check out the repo and run `npm install && npm run browser-login -- tabelog`.
  2. Sign in with Google in the window that opens, then close it.
  3. Copy the saved session to the VM:
     ```
     gcloud compute scp --recurse --zone <zone> data/browser/tabelog date-night:~/date-night-planner/data/browser/
     ```
  4. Restart the service.

  If Google refuses the sign-in in that window, Tabelog places fall back to email or manual booking for now.

## 7. Check and go live

1. Run `npm run import-csv -- fixtures/Tokyo_food.csv Advait "Tokyo food"`, then `npm run audit`. Read `audit-report.md` to see how your saved places can be booked.
2. In the group, say "planner plan next Wednesday". Check that the options and poll look right, vote, and check that the dry-run booking reaches the confirm step.
3. When happy, set `DRY_RUN=0` and restart: `sudo systemctl restart date-night-planner`.
