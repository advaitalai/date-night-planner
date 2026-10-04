# Date Night Planner

A WhatsApp agent for Advait and Emily that plans the weekly date night and handles reservations from start to finish.

Every Saturday it posts three options for the following Wednesday as a poll. Each option comes with a short pitch, and each has been checked for a free table first. When you both vote for the same one, it books it. After that it watches the cancellation deadline, changes or cancels the booking if you ask, and reminds you on the day.

You can also just talk to it in the group:

- "@planner feeling Italian, not too far from work"
- "@planner somewhere like Monna Lisa"
- "@planner move it to 19:30"
- "@planner cancel Wednesday"

## How it works

```
WhatsApp group ⇄ Baileys ─┐
Onboarding web (Fastify) ─┼─► Agent (Claude tool loop) ─► Recommender ─► Booking adapters
Scheduler (SQLite jobs) ──┘                                               ├ TableCheck (API + browser)
                                                                          ├ Tabelog (browser)
                                                                          └ Email (Gmail, Japanese templates)
```

| Area | Where | Notes |
|---|---|---|
| Chat | `src/wa/whatsapp.ts` | Runs on a spare number added to the group. It replies when @-mentioned, called "planner" or replied to. Votes are counted by decrypting the poll responses. |
| Agent | `src/agent/` | A Claude tool loop with tools to recommend, book, check, change, cancel, set preferences and add places. |
| Recommender | `src/recommender/` | Turns a free-text request into constraints, then: saved-list and discovered candidates → filters → scoring (cuisine rotation, both-saved boost, similarity) → availability check → 3 varied options → pitches. |
| Booking | `src/booking/` | A shared adapter interface. TableCheck availability comes from its public diner API. TableCheck and Tabelog bookings run through a headless browser logged into your accounts. Email uses fixed, polite Japanese templates. |
| Policies | `src/booking/service.ts` | The cancellation policy is read with an LLM and turned into a free-cancel deadline. The bot asks "still on?" 48h and 24h before it. |
| Saved lists | `src/places/takeout.ts`, `src/jobs/takeoutWatch.ts` | Takeout CSV/zip import. Each place is matched to Google Places by its Maps ID. Recurring Takeout exports are picked up from Drive automatically. |
| Schedule | `src/jobs/` | Sat 10:00 kickoff, Sun 10:00 nudge, Sun 20:00 book the top-voted option, reminders, Gmail reply watcher. All times can be changed from the chat. |

## Setup

1. **Install:** `npm install`, then `cp .env.example .env` and fill it in. You need:
   - an Anthropic API key;
   - a Google Cloud project with the **Places API (New)**, **Routes API**, **Gmail API** and **Drive API** enabled, plus an API key and an OAuth web client. Set the redirect URI to `<PUBLIC_BASE_URL>/oauth/callback` and set the OAuth app to **In production** so refresh tokens don't expire after 7 days;
   - the name, phone and email to put on bookings, and your TableCheck and Tabelog logins.
2. **Seed the saved places:**
   ```
   npm run import-csv -- fixtures/Tokyo_food.csv Advait "Tokyo food"
   ```
3. **Check how each place can be booked:** `npm run audit` writes `audit-report.md`, which shows how many places the bot can book itself and how many are phone-only.
4. **Run:** `npm start`.
   - Scan the QR code with the bot's phone (WhatsApp → Linked devices).
   - Add the bot to your group. The log prints each group's id: put it in `WA_GROUP_JID` and restart.
   - In the group, say `@planner setup` to get each person's onboarding link (connect Google, then the one-time Takeout export).
5. **Deploy to Fly.io** (Tokyo region, always on):
   ```
   fly launch --no-deploy
   fly volumes create planner_data --region nrt --size 1
   fly secrets set ANTHROPIC_API_KEY=... GOOGLE_MAPS_API_KEY=... (everything else in .env)
   fly deploy
   fly logs   # scan the WhatsApp QR from here on first boot
   ```

Keep `DRY_RUN=1` until each booking flow has been checked live. In dry-run mode the browser stops before the final confirm click, and emails go to `BOOKING_EMAIL` instead of the restaurant.

## Development

```
npm test           # vitest
npm run typecheck  # tsc
```

The plan and what comes next are in [`docs/BACKLOG.md`](docs/BACKLOG.md).
