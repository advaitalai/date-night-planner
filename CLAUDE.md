# Date Night Planner

A WhatsApp agent that plans Advait and Emily's weekly date night and books it end to end.

**Read `docs/REQUIREMENTS.md` first.** It has the requirements, decisions, the MVP success event, known gaps, and how to start a session. Also see `docs/SETUP.md` (accounts and deployment) and `docs/BACKLOG.md` (what's next).

## Commands

- `npm test`: unit tests (vitest)
- `npm run typecheck`: tsc
- `npm run chat`: talk to the agent in the terminal (no WhatsApp needed)
- `npm run import-csv -- <file> <Advait|Emily> [list]` / `npm run audit`
- `npm start`: full app (WhatsApp, scheduler, onboarding web page)

## Rules

- Keep `DRY_RUN=1` unless Advait explicitly says to make a real booking or cancellation.
- The repo is public. Never commit secrets or personal contact details; they go in `.env` or environment variables. Never ask for keys in the chat.
- Never claim a booking was made, changed or cancelled unless a tool or site confirmed it.
- Update `docs/REQUIREMENTS.md` §7 (known gaps) and `docs/BACKLOG.md` when things change.
