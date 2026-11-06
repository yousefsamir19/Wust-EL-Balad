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

- Task 01: runnable React/Vite/Tailwind + Express/TypeScript foundation, shared health contract, environment template, and CI. Simulation and gameplay are not implemented yet.
- Task 02: versioned SQLite migrations and ten seeded Cairo citizens, buildings, directed relationships, and private initial knowledge. `GET /api/world/summary` returns a safe public summary.
- `DATABASE_URL` defaults to `file:./data/world.db`. Startup creates the database once and reopens it without reseeding. Amounts in storage are integer piastres (100 piastres = 1 EGP). Keep the `data` directory on durable storage; do not copy an active WAL database for backups.
- AI-to-AI dialogue will appear in each participant's Character Chat. Interrogation uses only that citizen's observations, received information, or beliefs.
- Rumors require all registered, non-banned players to approve, with a 24-real-hour timeout.
- Simulation time does not advance while the server is off.

No Manus SDK, proxy, external authentication service, or managed database is required. Do not commit credentials, world databases, or backups.
