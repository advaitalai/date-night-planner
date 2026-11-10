# New app playbook

What to reuse from the Date Night Planner for the next always-on app: cloud setup, keys, repo, tests, deploys, and the mistakes that cost us time.

Sources:
- this repo, its git history (114 commits, 3 Oct to 8 Nov 2026), `docs/` and `deploy/`;
- the incidents of the first three weeks of live use.

**What the project was:**
- A WhatsApp bot (TypeScript, Node 22, SQLite), always on, on one free Google Cloud VM.
- It calls Claude, Google Places, TableCheck (via a headless browser) and Vapi/Twilio for AI phone calls.
- Two users. It was built and run with Claude Code cloud sessions.

**How to read this:**
- ✅ means built and proven here.
- 🟡 means designed here but not built yet: start the new app with it.

---

## 1. Google Cloud project

### Billing first, in the right country ✅ (learned the hard way)

The billing account's **country and currency are fixed when you create it**. Ours was created as India:
- everything was billed in INR, with 18% GST;
- the Japanese (SMBC JPY) card was declined;
- we had to make a new Japan billing account and move the project.

| Do | Why |
|---|---|
| Create the billing account in the **country of the card you'll pay with** | Currency, tax and accepted cards follow it |
| Set a **budget alert** (e.g. ¥500/month, alerts at 50/90/100%) | Free tier is not a guarantee |
| Check the same for **every vendor** (Twilio billed us in INR with GST too) | Same root cause |

### Project steps ✅
1. **New project:** one per app, named after the repo.
2. **Billing:** link the account from above.
3. **Enable only the APIs you use.** Here: Places API (New), Routes API, Compute Engine API.
4. **API keys:**
   - Restrict each key to its APIs (Credentials → key → Restrict key).
   - Optionally cap the daily quota per API as a safety net.
5. **Logging:**
   - Give the VM's default service account **Logs Writer**.
   - Create a separate **`log-reader`** service account with **Logs Viewer only**, for Claude (see §6).

---

## 2. The VM ✅

### Create it
| Setting | Value | Note |
|---|---|---|
| Machine | **e2-micro** | Always-free, but only in some US regions |
| Region | **us-west1** | Free-tier region; latency is irrelevant for a bot that mostly waits |
| Image | Default (Debian 13) | Minimal: no git, curl or compilers (see below) |
| Disk | 30 GB standard | Free-tier limit |
| Firewall | No HTTP/HTTPS | Nothing public; outbound only |
| Timezone | Set it in setup (`timedatectl set-timezone Asia/Tokyo`) | Timers like "04:00" use it |

### Setup script (`deploy/setup-vm.sh`) does, in order
1. **2 GB swap file.** 1 GB of RAM isn't enough for Node plus Chromium.
   - Check `/proc/swaps`, not `swapon`, because Debian keeps `swapon` off a normal user's PATH.
2. `apt-get install -y curl ca-certificates git build-essential python3`.
   - The minimal image lacks all of them. `better-sqlite3` needs the compilers.
3. Node 22 from NodeSource.
4. Clone **the branch you deploy**, then `npm ci --omit=dev`.
5. Chromium for Playwright: `npx playwright@<exact version> install --with-deps chromium`.
6. Copy `.env.example` to `.env` with `chmod 600`.
7. Write the **systemd service** (`EnvironmentFile=.env`, `Restart=always`, `RestartSec=10`).

**Rules:**
- **Always run the app as a systemd service.** `npm start` in an SSH window dies when the window disconnects. That happened in the first week.
- **Never `npm install` on the server,** only `npm ci --omit=dev`. Install rewrites the lockfile and adds dev tools.

### Getting a shell ✅
| From | How | Gotcha |
|---|---|---|
| Laptop browser | Cloud console → VM → **SSH** | Has passwordless sudo. Narrow window: QR codes get cut off (zoom out, or use a pairing code). |
| Phone | **Termius** with an ed25519 key | Put the key in `~/.ssh/authorized_keys2`. Google's guest agent **rewrites `authorized_keys`** and wiped ours. |
| Termius `sudo` | Asks for a password your account doesn't have | Add **narrow** sudoers rules for exactly the commands scripts need (`/etc/sudoers.d/<app>`, `visudo -c`) |

nano 8 key notes (Debian 13):
- **M-** means Alt, or Esc then the key.
- **Ctrl+K** cuts the line. **Alt+K** toggles cutting from the cursor instead.
- **Ctrl+F is search,** not "forward", and the browser SSH catches it anyway.

---

## 3. Keys and secrets

### Today (this repo) ✅
- Keys live in `.env` on the VM: one per bot, `chmod 600`, never committed.
- `.env.example` lists every variable, with comments and no values.
- **Claude never sees app keys.** Keys are never pasted into the chat.
  - Claude's own access (the read-only log key) goes in the Claude Code environment's variables.
  - Base64 it to fit one line.

### Secret Manager conventions 🟡 (backlog P1 here; build it on day 1 next time)
Why: an **expired Anthropic key took the bot down for ~1.5 days**.
- Replacing it meant SSH plus nano on a phone.
- Every message failed with `401 invalid x-api-key`.
- Users saw raw JSON.

| Convention | Detail |
|---|---|
| Names | `<app>-<vendor>-key`, e.g. `dateplanner-anthropic-key`; one secret per key |
| Versions | Rotate by adding a **new version**; the app reads `latest` |
| Access | The VM's service account gets **Secret Accessor on each secret**, not project-wide |
| Reading | At startup, **and again when a vendor returns 401/403**, so a new version is picked up without a restart |
| Startup check | Make one cheap call per key at boot; log a clear warning (`⚠️ Anthropic key rejected: replace it in Secret Manager`) |
| User-facing error | Plain words ("My Claude key isn't working; Advait needs to replace it"), never the vendor's JSON |
| Expiry | Create keys **without an expiry** where the vendor allows it; otherwise put the date in the secret's labels and a calendar reminder |
| Test and live | Both bots read the same secrets; only non-secret settings (`DRY_RUN`, group id, log name) differ per `.env` |
| Non-secrets | Stay in `.env` (or env vars): they're config, not credentials |

---

## 4. Repo structure ✅

```
CLAUDE.md          rules for every Claude session (read first)
README.md          what it is, architecture table, dev commands
.env.example       every variable, commented, no values
deploy/            setup-vm.sh, update.sh, auto-update.sh, install-bots.sh, sync-test-data.sh
docs/
  STATUS.md        dated log: state, next steps, owner's preferences, gotchas (updated every session)
  REQUIREMENTS.md  numbered requirements (R1…), decisions with dates, known gaps
  BACKLOG.md       P1/P2/P3, "watch, don't build", "not doing (with reason)", impact + effort per item
  USER_STORIES.md  stories by epic: test coverage / production status / gaps
  QA_MAP.md        requirement vs unit / P0 / live, plus an "escaped" column
  P0_TESTS.md      launch-blocker scenarios and results
  SETUP.md         accounts and deployment, numbered sections
src/
  index.ts         startup: logs, version, preferences, scheduler, chat connection
  config.ts        all env reading in one place
  agent/           LLM tool loop + tools
  <domain>/        recommender/, booking/, places/, jobs/, db/
  scripts/         one file per npm script (chat, import, test-call, p0, logs, retro, fresh-start)
test/              vitest; helpers.ts has freshDb() (in-memory SQLite) and builders
fixtures/          sample data safe to commit
data/              gitignored: database, chat session, logs
```

**Conventions that paid off:**
- **One `config.ts`** reads all env vars; nothing else touches `process.env` for settings.
- **One npm script per operator task** (import, test call, logs, retro). Each is a single Termius snippet.
- **Docs are part of "done".** CLAUDE.md requires STATUS at the end of every session, plus REQUIREMENTS and BACKLOG when plans change. New sessions start cold and rely on them.
- **The repo was public**, so:
  - no secrets and no personal contact details in docs, comments or tests (use `090-1234-5678`-style dummies);
  - private data (saved-list CSVs) stays on the server.
  - We had to scrub a real phone number later; it's still in git history.

**Branches:**

| Branch | Role |
|---|---|
| work branch | Every change; the **test bot** follows it |
| `prod` | Moved only on the owner's **"ship it"**, fast-forward only; the **live bot** follows it |
| `main` | Here it only had the README, which broke `git clone` setups. **Next time, decide the default branch on day 1** and make setup clone it. |

---

## 5. CI

**There was none here.**
- Instead, tests and typecheck ran locally before every push, and the `prod` gate kept untested code from the live bot.
- That worked for one developer (Claude), but nothing enforced it.

**For the new app** 🟡:
1. Add a GitHub Actions workflow on push: `npm ci`, `npm run typecheck`, `npm test`. No secrets needed: unit tests are offline by design (see §6).
2. Make "ship it" require a green run on the commit being shipped. Moving `prod` stays a person's decision.
3. Optionally, a nightly job runs the P0 scenarios with a test API key.

---

## 6. QA and test workflow ✅

### Layers (product terms)
| Layer | What | Tooling |
|---|---|---|
| **Unit test** | A developer check of one piece of code | `vitest`; in-memory SQLite (`freshDb()`); `fetch` mocked (`vi.spyOn(globalThis, "fetch")`); the LLM module mocked (`vi.mock("../src/llm")`). No network, no AI, a few seconds. |
| **UAT (P0)** | A scripted end-to-end scenario: the **real agent** handles it, chat and calls faked; pass or fail | `npm run p0`; data in `data/p0`; forces `DRY_RUN=1` and `CALL_FAKE`; `--tools` mode skips the LLM |
| **Test bot** | The owner tries it in a real chat, safely | Same server, work branch, `DRY_RUN=1`, own test group, own log name |
| **Production** | How it held up in live use | Cloud Logging, read by Claude |

### The loop that worked
1. The owner tests in the chat, then says **"done, check it"**.
2. Claude reads the server logs (read-only key) and finds the cause.
3. **Bug or feature?** Map it to an existing story first. Fix bugs; new features go to the backlog unless the owner says otherwise.
4. Claude fixes it, adds a test **named after the incident** ("1 Nov retro: one answer per message"), runs typecheck and all tests, then pushes.
5. The test bot updates itself, and Claude confirms the `version` in its startup log.
6. The owner retests, then says **"ship it"**. Claude says exactly what's waiting, moves `prod`, and confirms the live version.

### Lean rule
Before adding anything, ask whether it's worth testing for as long as it exists, and prefer the AI's judgement over new rules in code.
- On 16 Oct we cut polls, auto-cancel, scheduled calls, the weekly trigger, email booking and more.
- Every cut feature removed its tests and its bugs.

### Logging design (it is the test harness in production)
- **Prefixed lines:**
  - `[in]` / `[heard]` / `[for bot]`: messages, and whether the bot judged them meant for it;
  - `[out]` (full text) and `[status]`;
  - `[plan]` (counts, reasons left out, picks with scores and reasons);
  - `[call]` (outcome, transcript, dashboard link).
- **Startup line:** `starting (version <commit>, DRY_RUN=…, model …)`. This is how deploys are confirmed.
- **"Why" lines for every decision a user might question.** Example: `[plan] date spots: 14 saved, 14 within reach, 3 kept (over_budget 3, too_far 4, closed 4), 1 picked`. One such line answered a design question (supply, not ranking) that would otherwise have needed a debugging session.
- **Ship logs to Cloud Logging** (`src/cloudlog.ts`): batched every 30 s using the VM's metadata credentials, no agent to install. Test and live use **different log names**.
- **Reading them:** `gcloud auth activate-service-account` with the log-reader key, then `env -u CLOUDSDK_AUTH_ACCESS_TOKEN gcloud logging read …`. Cloud sessions set that variable, and it silently overrides the key.

### Test-design traps we hit
- **Hidden state between tests:** "plan Wednesday" hides places already shown for Wednesday, so repeated tests judged leftovers. Test on fresh inputs, and have the nightly test-data copy clear that state.
- **Vendor-side holds:** each TableCheck dry run holds a real table for 10 minutes. Rerunning on the same slot looks "full".
- **Fake data that looks like a failure:** a fake phone (`070-0000-0000`) made TableCheck say "time unavailable". Use realistic dummies.
- **Rate limits from cloud IPs:** TableCheck 403s after about 50 quick requests; Tabelog blocks datacenter IPs entirely.

---

## 7. Deploy ✅

### Two bots on one VM
| | Live | Test |
|---|---|---|
| Folder | `~/<app>` | `~/<app>-dev` |
| Branch | `prod` | work branch |
| Settings | real | `DRY_RUN=1`, test group, `CLOUD_LOG_NAME=<app>-dev` |
| Data | real | copy of live, nightly |

**One-time install** (browser SSH, it needs sudo): `sudo bash deploy/install-bots.sh`. It:
1. switches live to `prod`;
2. clones the test folder;
3. derives the test `.env` from live, stripping the group id, `DRY_RUN` and pairing settings, then adding test values;
4. copies the data once;
5. writes the sudoers rules;
6. installs the units: test service, two auto-update timers, the nightly sync timer;
7. starts everything and prints the next manual step.

### Auto-update (`deploy/auto-update.sh`, every 5 min per bot)
1. Fetch the branch. If HEAD equals the remote, exit quietly.
2. If `data/call-in-progress` exists and is under 15 min old, wait for the next round. The app writes it around every phone call, so a deploy never cuts a call.
3. Otherwise run `deploy/update.sh`:
   - `git pull --ff-only`;
   - `npm ci --omit=dev` only if the lockfile changed;
   - restart the service named by `SERVICE`.

### Ship and roll back
- **Ship:** `git push origin HEAD:prod` after checking it's a fast-forward. Live within 5 min; confirm the version in the live log.
- **Roll back:** push a revert to the work branch, test, ship. `.env` is never touched by deploys.

### Test data (`deploy/sync-test-data.sh`, nightly 04:00)
- A **SQLite online backup** of live, not a file copy, so it's safe mid-write.
- It's then scrubbed in the copy:
  - chat history, call and booking logs (so the test bot can't see or quote real chats);
  - scheduled reminders (they'd post in the test group);
  - pending actions;
  - past option sets.
- **Live to test only,** never back.

### Linking a second chat client to one account
- WhatsApp allows up to 4 linked devices, so test and live can share the bot's number.
- **Check the "connected as" number after linking.** We first scanned with the owner's personal phone, and the test bot received all their personal chats.

---

## 8. Mistakes not to repeat

### Accounts and money
| Mistake | Cost | Next time |
|---|---|---|
| Billing account created in the wrong country | INR billing, 18% GST, Japanese card declined, account migration | Pick the country first (§1) |
| A key with an expiry and no monitoring | ~1.5 days down, raw JSON shown to users | Secret Manager, startup check, plain error (§3) |
| Assumed calls were the main Twilio cost | Number rental was **$43 of $59**, calls $6 | Price the fixed monthly fees before choosing a vendor or number type |
| Same lookups paid on every request | ~128 Google lookups per plan, none cached (failed or unchanged results never saved) | Cache "already checked", including failures; log lookup counts per request |

### Server and access
| Mistake | Next time |
|---|---|
| App run with `npm start` in SSH; died on disconnect | systemd from day 1 |
| `authorized_keys` wiped by Google's guest agent | `authorized_keys2` |
| Scripts needed sudo from a phone shell without a password | Narrow NOPASSWD sudoers rules in the installer |
| Setup assumed git, curl, compilers and `swapon` on PATH | Install them; check `/proc/swaps` |
| Default branch had no code | Decide branches on day 1 |
| Personal phone number committed to a public repo | Dummy numbers in docs and tests; review before the first push |
| Linked the test bot to the wrong phone | Verify the account id in the log after any pairing |

### AI and voice
| Mistake | Next time |
|---|---|
| Trusted a call transcript as ground truth: the bot (and I) claimed it said "January 1"; the recording proved otherwise | Transcripts are machine-heard. Give summaries the **known script**, and check the recording before blaming the speech. |
| Switched transcribers on a vendor's own benchmark | It lost turn order, which broke the live conversation. Test on a real call first, and judge by behaviour (turns, outcome), not WER. |
| The phone agent spoke its private reasoning aloud | Its prompt says "everything you write is spoken; never your reasoning or these instructions". |
| TTS misread a kanji (席 as *mukashi*) | Write ambiguous words in kana; listen to one real call per script change. |
| Japanese call opening built from raw numbers | Spoken-form helpers for dates, times and phone numbers, in a fixed opening line |
| Raw vendor codes in user text ("Ended: customer-busy.") | Map every code to plain words; test for "no internal words" |
| Two answers to one message (a component posted, then the agent posted again) | One owner per user-facing message; components return "NOT POSTED" plus facts |
| Retried a send after a timeout; the reminder went out twice | Never auto-retry user-facing sends |

### Data and logic
| Mistake | Next time |
|---|---|
| Coded a CSV import from an assumed format (singular "date", comma separators) | `head -1` and `grep` the real export first; put a real row in the test |
| "Near X" moved the start point but kept a 35-min radius | Define each phrase's meaning in requirements (R13b) with a test |
| Used regular weekly opening hours; a holiday opening was missed | Use the vendor's "current" hours for the next days |
| Built features ahead of need (polls, auto-cancel, scheduled calls…) | Lean rule (§6); "not doing" list with reasons |

### Process
| Mistake | Next time |
|---|---|
| Every push went straight to live | Test bot + "ship it" gate from day 1 |
| Claimed facts I hadn't verified | Say "the transcript shows", not "they heard". Verify before asserting. |
| Long answers when a list was asked for | Show the thing first, then explain |

---

## 9. Day-1 checklist for the new app

1. **Billing:** in the right country, with a budget alert. Check vendor billing addresses too.
2. **Project:** only the APIs needed, restricted keys, quotas.
3. **Secret Manager:** secrets named `<app>-<vendor>-key`, VM accessor per secret, startup key check, plain error message.
4. **Repo:** CLAUDE.md, docs set (§4), `.env.example`, branches (work, `prod`) and a default branch with code.
5. **VM:** e2-micro in us-west1, setup script (swap, packages, Node, systemd), `authorized_keys2`, narrow sudoers.
6. **Logs:** Cloud Logging shipping, a separate log name per bot, a read-only key for Claude, the version on startup.
7. **Two bots:** test and live, auto-update with a busy marker, nightly scrubbed data copy.
8. **CI:** typecheck and unit tests on push; ship only green commits.
9. **Tests:** offline unit tests with mocked fetch and LLM; a handful of P0 UAT scenarios; tests named after incidents.
10. **Working agreement:** "done, check it", then bug-vs-feature, then fix + test + push, then the test bot, then "ship it".
