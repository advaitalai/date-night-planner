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
| Chat | `src/wa/whatsapp.ts` | A linked device on your own WhatsApp (messages start with 🤖) or on a separate number. It replies when called "planner" or replied to. Votes are counted by decrypting the poll responses. |
| Agent | `src/agent/` | A Claude tool loop with tools to recommend, book, check, change, cancel, set preferences and add places. |
| Recommender | `src/recommender/` | Turns a free-text request into constraints, then: saved-list and discovered candidates → filters → scoring (cuisine rotation, both-saved boost, similarity) → availability check → 3 varied options → pitches. |
| Booking | `src/booking/` | A shared adapter interface. TableCheck availability comes from its public diner API, and bookings are made as a guest in a headless browser. Tabelog bookings use a saved login in the same browser. Email uses fixed, polite templates: Japanese first, then English. |
| Policies | `src/booking/service.ts` | The cancellation policy is read with an LLM and turned into a free-cancel deadline. The bot asks "still on?" 48h and 24h before it. |
| Saved lists | `src/places/takeout.ts`, `src/jobs/takeoutWatch.ts` | Takeout CSV/zip import. Each place is matched to Google Places by its Maps ID. Recurring Takeout exports are picked up from Drive automatically. |
| Schedule | `src/jobs/` | Sat 10:00 kickoff, Sun 10:00 nudge, Sun 20:00 book the top-voted option, reminders, Gmail reply watcher. All times can be changed from the chat. |

## Setup

The full step-by-step guide is in [`docs/SETUP.md`](docs/SETUP.md). In short:

1. **Anthropic API key** (console.anthropic.com, prepaid credits). This is the only paid part, about a few dollars a month.
2. **Google Cloud project:** Places, Routes, Gmail and Drive APIs; a Maps API key; an OAuth client with an "In production" consent screen.
3. **Free e2-micro VM** (us-west1), set up with `deploy/setup-vm.sh`. It runs the bot 24/7 as a systemd service.
4. **WhatsApp:** link the bot to your own WhatsApp (no spare SIM needed; its messages start with 🤖), or to a separate number.
5. **Connect Google** for both of you through an SSH tunnel, then do the one-time Takeout export.
6. **Booking sites:** TableCheck works as a guest. For Tabelog, log in once with `npm run browser-login -- tabelog`.
7. **Check, then go live:** `npm run audit`, a dry run in the group, then `DRY_RUN=0`.

Keep `DRY_RUN=1` until each booking flow has been checked live. In dry-run mode the browser stops before the final confirm click, and emails go to `BOOKING_EMAIL` instead of the restaurant.

## Development

```
npm test           # vitest
npm run typecheck  # tsc
```

Requirements and decisions: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). What comes next: [`docs/BACKLOG.md`](docs/BACKLOG.md).
