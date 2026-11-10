# Date Night Planner

A WhatsApp agent for Advait and Emily that plans the weekly date night and handles reservations from start to finish.

Ask it for options ("plan Wednesday", "something Thai near work on Friday") and it posts three, each with a short pitch. Talk it over between you; when either of you decides (or the bot hears you settle it and you confirm), it books: on TableCheck if it can, otherwise by an AI phone call in Japanese. After that it reminds you a day before free cancellation ends, changes or cancels the booking if you ask, and reminds you on the day.

Talk to it like a third person in the group. It works out which messages are for it ("What's booked?") and which are you two talking ("babe, which one?"). Replying inline to it, or using its name, always counts:

- "planner feeling Italian, not too far from work"
- "somewhere like Monna Lisa" (as a reply to the options)
- "move it to 19:30"
- "cancel Wednesday"

When you two settle on an option between yourselves, it asks before booking.

## How it works

```
WhatsApp group ⇄ Baileys ─┐
                          ├─► Agent (Claude tool loop) ─► Recommender ─► Booking
Scheduler (SQLite jobs) ──┘                                              ├ TableCheck (API + browser)
                                                                         └ AI phone call (Vapi + Twilio)
```

| Area | Where | Notes |
|---|---|---|
| Chat | `src/wa/whatsapp.ts` | A linked device on your own WhatsApp (messages start with 🤖) or on a separate number. Answers inline replies, its name, and messages it judges are meant for it; listens to the rest. |
| Agent | `src/agent/` | A Claude tool loop with tools to recommend, book, check, change, cancel, and set preferences. It judges decisions and go-aheads from the conversation. |
| Recommender | `src/recommender/` | Turns a free-text request into constraints, then: saved-list and discovered candidates → filters → scoring (cuisine rotation, both-saved boost, similarity) → 3 varied options → pitches. |
| Booking | `src/booking/` | TableCheck availability from its public diner API, bookings as a guest in a headless browser. Phone-only places get an AI call (`calls.ts` decides when, `phone.ts` makes it). |
| Policies | `src/booking/service.ts` | The cancellation policy is read with an LLM and turned into a free-cancel deadline. One "still on?" a day before it. |
| Saved lists | `src/places/takeout.ts` | Takeout CSV/zip import (`npm run import-csv`). Each place is matched to Google Places by its Maps ID. |
| Reminders | `src/jobs/` | For every booking: one "still on?" a day before free cancellation ends, the day-of reminder, the visit log. No weekly trigger. |

## Setup

The full step-by-step guide is in [`docs/SETUP.md`](docs/SETUP.md). In short:

1. **Anthropic API key** (console.anthropic.com, prepaid credits).
2. **Google Cloud project:** Places and Routes APIs, a Maps API key.
3. **WhatsApp:** link the bot to your own WhatsApp (its messages start with 🤖), or (planned) to its own number.
4. **Saved places:** import a Takeout CSV per person.
5. **AI phone calls:** Vapi plus a Twilio number.
6. **Check, then go live:** a dry run in the group, then `DRY_RUN=0`.

Keep `DRY_RUN=1` until each booking flow has been checked live. In dry-run mode the browser stops before the final confirm click, and calls go to you instead of the restaurant.

## Development

```
npm test           # vitest
npm run typecheck  # tsc
npm run p0         # launch-blocker tests (real bot, fake WhatsApp and calls)
npm run chat       # talk to the bot in the terminal ("~ text" = said to the other person)
```

Start with [`docs/STATUS.md`](docs/STATUS.md), then [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). What comes next: [`docs/BACKLOG.md`](docs/BACKLOG.md).
