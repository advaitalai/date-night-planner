# Date Night Planner

A WhatsApp agent that plans Advait and Emily's weekly date night and books it end to end.

**Read `docs/STATUS.md` first** (where the project is, next steps, Advait's preferences, gotchas), **then `docs/REQUIREMENTS.md`**. It has the requirements, decisions, the MVP success event, known gaps, and how to start a session. Also see `docs/SETUP.md` (accounts and deployment), `docs/BACKLOG.md` (what's next) `docs/USER_STORIES.md` (what the build does and how tested each story is) and `docs/QA_MAP.md` (requirements vs tests, what escaped and why).

## Commands

- `npm test`: unit tests (vitest)
- `npm run typecheck`: tsc
- `npm run chat`: talk to the agent in the terminal (no WhatsApp needed)
- `npm run import-csv -- <file> <Advait|Emily> [list]` / `npm run audit`
- `npm start`: full app (WhatsApp, scheduler, onboarding web page)
- `npm run logs` / `npm run logs -- call <id>`: recent calls and booking attempts (debugging); full log in `data/logs/`
- `npm run retro -- <since>`: week-in-review report (`data/retro.md`)
- `npm run p0`: launch-blocker tests (real bot, fake WhatsApp and calls); `npm run fresh-start`: clear test leftovers
- Server logs (Google Cloud VM): read-only with `GCP_LOG_READER_KEY`, see `docs/SETUP.md` §10

## Rules

- Keep `DRY_RUN=1` unless Advait explicitly says to make a real booking or cancellation.
- The repo is public. Never commit secrets or personal contact details; they go in `.env` or environment variables. Never ask for keys in the chat.
- Never claim a booking was made, changed or cancelled unless a tool or site confirmed it.
- Update `docs/STATUS.md` at the end of every session (state, next steps, new preferences, feedback), plus `docs/REQUIREMENTS.md` and `docs/BACKLOG.md` when requirements or plans change.
- House style for anything the bot or you write for Advait: rich formatting, short lines, no em dashes.
