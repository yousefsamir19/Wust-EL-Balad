# Wust El Balad

A standalone multiplayer pixel-art society set in downtown Cairo. Ten autonomous citizens live their own lives while up to six observers investigate. Currency: **EGP**. Newspaper: **The Downtown Gazette**.

## Run

Requires Node.js 22 or newer and npm. From the repository root:

```sh
npm install
```

Copy `.env.example` to `.env` (Windows: `copy .env.example .env`; Linux/macOS: `cp .env.example .env`). Credentials can remain empty for Task 01.

```sh
npm run build
npm start
```

Open http://localhost:3000. Express serves the frontend and `/api/health` on the same port. `PORT` changes the production port; `HOST` defaults to `0.0.0.0`.

Development: `npm run dev` (frontend http://localhost:5173, API port 3000 or `PORT`).

Checks: `npm run typecheck`, `npm run lint`, `npm test`.

## Progress and rules

- Task 01: runnable React/Vite/Tailwind + Express/TypeScript foundation, shared health contract, environment template, and CI.
- Task 02: versioned SQLite migrations and ten seeded Cairo citizens, buildings, directed relationships, and private initial knowledge. `GET /api/world/summary` returns a safe public summary.
- `DATABASE_URL` defaults to `file:./data/world.db`. Startup creates the database once and reopens it without reseeding. Amounts in storage are integer piastres (100 piastres = 1 EGP). Keep the `data` directory on durable storage; do not copy an active WAL database for backups.
- Task 03: signup/login/logout, persistent hashed sessions, username/avatar updates, and admin authorization. Usernames: 3–24 ASCII letters, digits, or underscores; passwords: 10–128 characters. Six non-banned observer accounts can register; the separate administrator does not occupy a player slot. Avatar artwork arrives in Task 06.
- Accounts use server-side sessions, so `JWT_SECRET` is reserved and unused. Set `SESSION_COOKIE_SECURE=true` behind production HTTPS. For one-time admin creation, set `ADMIN_SECRET` to at least 32 characters and POST `{username,password,confirmPassword}` to `/api/auth/admin/bootstrap` with the secret in `x-admin-secret`. Use HTTPS remotely; never embed this secret in frontend code. Existing admins log in normally. `/api/auth/admin/status` requires an authenticated admin.
- Task 04: durable clock/ticks, atomic idempotent world commands, once-only day boundaries, and single-writer protection. `DAY_DURATION_HOURS=6` means one game day per six real hours; `SIMULATION_TICK_MS=1000` controls committed tick frequency. `/api/world/summary` reports the current day, minute, tick, and version.
- The clock uses elapsed time while the process runs, not wall-clock catch-up. Zero observers do not stop it. Clean shutdown releases the writer lease; after a crash, a second process may need to wait for the stale lease (15 seconds with default settings). Run only one simulation instance per database. A storage failure stops the process rather than continuing unpersisted state.
- Task 05: four-direction pathfinding, non-overlapping movement, saved paths/work schedules, hunger/energy/social needs, and utility-based work/eat/sleep/social decisions. Routine activity and contextual dialogue work with no AI key. Buildings are logical entrance zones at this stage; the pixel map/UI arrives in Tasks 06–08, economy in Task 09.
- After signing in, open `/api/world/citizens` to inspect the authenticated read-only positions, activities, and building zones. It exposes no private thoughts, memories, secrets, or credentials. Each tick saves movement, needs, routine state, and generated activity records in one transaction.
- Task 06: self-contained pixel matrices generate terrain/trees/flowers/lamps, seven distinct building types, ten portraits, four-direction three-frame walking sprites, and HUD/job/emote icons. Click **Preview pixel art** to see the animated atlas. Profiles show the selected generated observer portrait. No sprite downloads or external images are needed.
- Task 07: authenticated Socket.IO snapshots and committed/versioned deltas share the same world with all observers. Login to see the live day/time, unique connected-player count, tick, and movement readout. Reconnects receive fresh snapshots; gaps trigger resynchronization, duplicate/old deltas are ignored, and revoked/banned sessions are disconnected. Socket clients cannot pause or set world state.
- Task 08: click **Enter town** after login for the map-led pixel-RPG HUD. Drag/touch-pan, pinch or use +/- to zoom, tap a citizen to inspect, and use **Follow on map**. Desktop uses side panels; mobile uses bottom navigation and slide-up sheets. Day/night lighting follows the server clock. Pixel fonts are bundled locally. Tools link to the planned gameplay views and explicitly label panels awaiting their later tasks.
- Task 09: attendance-based wages, daily rent, paid meals/stock, employment changes, segregated savings, loans/repayments, and overdue/shortfall consequences run in the authoritative transaction. Amounts are integer piastres. Fictional defaults: meals EGP 25, daily rent EGP 20, full-shift wages EGP 80–120; businesses and bank lending begin with finite capital. Loan limits, opening hours, funded vacancies, balances, and retries are validated. Players cannot directly move NPC money or change jobs.
- After login, `GET /api/economy/karim` (or another citizen ID) shows the public economic statement/transaction ledger; the character sheet shows live cash, savings, and debt. Unaffordable food does not restore hunger, and restarting does not pay wages or charge rent twice.
- Task 10: witnessed events and received dialogue update directed trust, affection, respect, fear, debt, grudge, suspicion, dependence, reputation, mood, goals, and uncertain beliefs. Routine witnesses are captured when events occur. Hidden actions do not automatically tell their victim who performed them, and financial records are known only to their participants/owners.
- The five memory layers have strict storage caps (24 short-term, 32 episodic, 24 relationship, 32 belief, 16 long-term) and source-event provenance; knowledge is capped at 48 entries. AI retrieval uses at most 20 memories, 6 beliefs, 6 own conversations, 6 relationships, 5 authorized secrets, and 8 debts with a separate debt total. Compaction never removes canonical dialogue history or turns hearsay into confirmed facts. Secret sharing requires an actual holder and records uncertain, private provenance.
- The character sheet's social panel and authenticated `GET /api/social/karim` show all outgoing relationship dimensions and disclosed memories. Private goals, private knowledge, secret identifiers, and the internal AI context are not exposed. No external AI service is needed for these updates.
- Task 11: official Gemini, NVIDIA NIM, OpenRouter, Groq, native Ollama, and custom OpenAI-compatible transports feed a bounded queue with request/token budgets, timeouts, at most two attempts per provider, per-key errors, origin-wide 429 backoff, ordered fallbacks, and a validated local policy. Missing keys or failed providers do not stop the clock. Idle citizen requests are throttled; opt-in batching never mixes different citizens' private contexts. Runtime provider settings arrive in Task 12; citizen reasoning uses this infrastructure in Task 13.
- Set `GEMINI_API_KEY` and `GEMINI_MODEL`, or configure `AI_PROVIDERS_JSON` with provider `id`, `kind`, `model`, `enabled`, `priority`, and `keys` containing `id`, `value`, and `enabled`. The transports supply vendor base URLs; `baseUrl` and model-dependent `jsonMode` (`schema`, `object`, `prompt`) can be specified. Compatible environment mode uses `OPENAI_COMPATIBLE_BASE_URL`, `AI_PROVIDER_MODEL`, and `AI_PROVIDER_KEY`, not a sandbox AI key. Never commit populated credentials. Additional private/local service origins must be explicitly listed in `AI_ALLOWED_ORIGINS`; default local Ollama port 11434 is permitted. DNS validation/pinning, body limits, and rejected redirects protect outbound requests.
- Authenticated administrators can GET `/api/admin/ai/status` and POST `/api/admin/ai/test`. The test reports `network` versus `local` rather than falsely treating fallback as a successful provider connection. Gemini quota is project-wide; rotation does not increase it. Protocol references: [Gemini](https://ai.google.dev/api/generate-content), [NIM](https://docs.api.nvidia.com/nim/reference/llm-apis), [OpenRouter](https://openrouter.ai/docs/api-reference/overview), [Groq](https://console.groq.com/docs/api-reference#chat-create), [Ollama](https://docs.ollama.com/api/chat).
- AI-to-AI dialogue will appear in each participant's Character Chat. Interrogation uses only that citizen's observations, received information, or beliefs.
- Rumors require all registered, non-banned players to approve, with a 24-real-hour timeout.
- Simulation time does not advance while the server is off.

No Manus SDK, proxy, external authentication service, or managed database is required. Do not commit credentials, world databases, or backups.
