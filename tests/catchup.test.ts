import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { openWorld } from '../server/src/db/index.js';
import { authRouter } from '../server/src/auth/routes.js';
import { catchUpRouter, markSeen, recordVisit } from '../server/src/catchup/index.js';
import { streamsRouter } from '../server/src/streams/index.js';
import { InvestigationService } from '../server/src/investigations/service.js';
import { SimulationClock, GAME_DAY_MS } from '../server/src/simulation/clock.js';

async function harness(withInvestigations = false) {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db, { dayDurationHours: 6 });
  const service = withInvestigations ? new InvestigationService(db, clock) : undefined;
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter(db));
  app.use('/api/catch-up', catchUpRouter(db, service));
  app.use('/api/chats', streamsRouter(db, clock));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function signup(username: string): Promise<string> {
    const response = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password-1234', confirmPassword: 'password-1234' }),
    });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const cookie = await signup('CatchUpPlayer');
  const playerId = (db.prepare("SELECT id FROM players WHERE username='CatchUpPlayer'").get() as { id: string }).id;
  const request = (path: string, method = 'GET', body?: unknown, auth = cookie) => fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { cookie: auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    db, clock, service, playerId, request,
    async close() {
      service?.stop(); clock.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

function closeDay(db: ReturnType<typeof openWorld>, clock: SimulationClock): void {
  clock.step((GAME_DAY_MS - clock.state().game_time_ms) * 6 / 24);
  assert.ok(db.prepare('SELECT day FROM closed_days WHERE day=1').get());
}

test('recordVisit preserves previous seen time, suppresses same-time duplicates, and keeps a stable return window', () => {
  const db = openWorld(':memory:');
  try {
    db.prepare("INSERT INTO players(id,username,password_hash,role,created_at) VALUES('p','P','unused','player',?)").run(new Date().toISOString());
    recordVisit(db, 'p', 100);
    recordVisit(db, 'p', 100);
    recordVisit(db, 'p', 200);
    markSeen(db, ['p', 'p'], 300);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM player_visits').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT previous_seen_game_ms AS value FROM player_visits ORDER BY id DESC LIMIT 1').get() as { value: number }).value, 100);
    assert.equal((db.prepare('SELECT from_game_ms AS value FROM player_returns WHERE player_id=?').get('p') as { value: number }).value, 0);
    assert.equal((db.prepare('SELECT last_seen_game_ms AS value FROM players WHERE id=?').get('p') as { value: number }).value, 300);
  } finally { db.close(); }
});

test('catch-up is authenticated, excludes the open current day, returns a bounded public DTO, and persists review/skip', async () => {
  const h = await harness(true);
  try {
    assert.equal((await h.request('/api/catch-up', 'GET', undefined, null)).status, 401);
    h.db.prepare("INSERT INTO events(world_version,game_time_ms,type,importance,visibility,details) VALUES(0,86399999,'public_record',60,'public',?)").run(JSON.stringify({ text: 'visible' }));
    h.db.prepare("INSERT INTO events(world_version,game_time_ms,type,importance,visibility,details) VALUES(0,86399998,'private_record',60,'private',?)").run(JSON.stringify({ text: 'hidden' }));
    h.db.prepare("INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,visibility) VALUES(86399999,'karim','mostafa','public line','public')").run();
    closeDay(h.db, h.clock);
    h.db.prepare('INSERT INTO day_archives(day,closed_game_ms,newspaper,major_event_ids) VALUES(1,86400000,?,?)').run(JSON.stringify({ day: 1, title: 'The Downtown Gazette', headline: 'A public headline' }), '[]');
    const first = await h.request('/api/catch-up');
    assert.equal(first.status, 200);
    const board = await first.json() as { currentDay: number; fromGameMs: number; days: Array<Record<string, unknown>>; hasMore: boolean };
    assert.equal(board.currentDay, 2);
    assert.equal(board.days.length, 1);
    assert.equal(board.days[0].day, 1);
    assert.equal(board.days[0].headline, 'A public headline');
    assert.equal(board.days[0].newspaperReady, true);
    assert.equal(board.days[0].publicEvents, 1);
    assert.equal(board.days[0].conversations, 1);
    assert.equal(board.days[0].investigationStatus, 'open');
    assert.equal(board.days[0].reviewed, false);
    assert.equal(JSON.stringify(board).includes('hidden'), false);
    assert.equal((await h.request('/api/catch-up?beforeDay=999')).status, 400);
    h.db.prepare("INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,visibility) VALUES(86400000,'karim','mostafa','next day line','public')").run();
    const history = await h.request('/api/chats/characters/karim?day=1');
    assert.deepEqual((await history.json() as { items: Array<{ text: string }> }).items.map((item) => item.text), ['public line']);
    assert.equal((await h.request('/api/chats/characters/karim?day=3')).status, 400);

    const reviewed = await h.request('/api/catch-up/1/review', 'POST', {});
    assert.equal(reviewed.status, 200);
    const reviewedBoard = await reviewed.json() as { days: Array<Record<string, unknown>> };
    assert.equal(reviewedBoard.days[0].reviewed, true);
    const reviewedAgain = await h.request('/api/catch-up/1/review', 'POST', {});
    assert.equal(reviewedAgain.status, 200);

    const before = h.clock.state().game_time_ms;
    const skipped = await h.request('/api/catch-up/1/skip', 'POST', {});
    assert.equal(skipped.status, 200);
    const skippedBoard = await skipped.json() as { days: Array<Record<string, unknown>> };
    assert.equal(skippedBoard.days[0].investigationStatus, 'skipped');
    assert.equal(skippedBoard.days[0].reviewed, true);
    assert.equal((h.db.prepare('SELECT influence FROM players WHERE id=?').get(h.playerId) as { influence: number }).influence, 0);
    assert.equal(h.clock.state().game_time_ms, before);
    assert.equal((await h.request('/api/catch-up/1/skip', 'POST', {})).status, 200);

    h.db.prepare('UPDATE players SET banned=1 WHERE id=?').run(h.playerId);
    assert.equal((await h.request('/api/catch-up')).status, 401);
  } finally { await h.close(); }
});
