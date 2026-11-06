import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { leaderboardRouter, playerProfilesRouter } from '../server/src/players/index.js';
import { openWorld } from '../server/src/db/index.js';
import type { WorldDatabase } from '../server/src/db/index.js';

const token = 'a'.repeat(64);
const cookie = `wust_session=${token}`;
const players = [
  ['p1', 'First', 'player', 20, 1],
  ['p2', 'Second', 'player', 20, 2],
  ['p3', 'Third', 'admin', 20, 3],
  ['banned', 'Banned', 'player', 99, 4],
] as const;

function fixture(db: WorldDatabase): void {
  const insert = db.prepare(`INSERT INTO players
    (id,username,password_hash,role,banned,avatar,influence,created_at) VALUES (?,?,?,?,0,?,?,?)`);
  for (const [id, username, role, influence, avatar] of players.slice(0, 3)) {
    insert.run(id, username, 'fixture', role, avatar, influence, new Date().toISOString());
  }
  db.prepare(`INSERT INTO players
    (id,username,password_hash,role,banned,avatar,influence,created_at) VALUES (?,?,?,?,1,?,?,?)`)
    .run('banned', 'Banned', 'fixture', 'player', 4, 99, new Date().toISOString());
  db.prepare('INSERT INTO sessions(token_hash,player_id,expires_at) VALUES (?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'), 'p1', Date.now() + 60_000);
}

function result(correctEvents: number, totalEvents: number, accuracy = totalEvents ? correctEvents / totalEvents : 0): string {
  return JSON.stringify({ correctEvents, totalEvents, accuracy, influenceAwarded: 0, source: 'local' });
}

async function running(db: WorldDatabase) {
  const app = express();
  app.use('/api/leaderboard', leaderboardRouter(db));
  app.use('/api/players', playerProfilesRouter(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function get(base: string, path: string, authenticated = true): Promise<Response> {
  return fetch(base + path, authenticated ? { headers: { cookie } } : undefined);
}

test('leaderboard derives weighted, durable statistics and stable rank order', async () => {
  const db = openWorld(':memory:');
  fixture(db);
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i1', 'p1', 1, '{}', 'submitted', result(1, 2), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i2', 'p1', 2, '{}', 'submitted', result(2, 4), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i3', 'p1', 3, '{}', 'skipped', result(1, 1), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i4', 'p1', 4, '{}', 'pending', result(1, 1), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i5', 'p2', 1, '{}', 'submitted', result(0, 0), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('i6', 'p3', 1, '{}', 'submitted', result(1, 2), new Date().toISOString());
  for (const [day, outcome] of [[1, 'accepted'], [2, 'considered'], [3, 'ignored'], [4, 'rejected']] as const) {
    db.prepare(`INSERT INTO interventions
      (id,player_id,day,citizen_id,strength,suggestion,cost,outcome) VALUES (?,?,?,?,?,?,?,?)`)
      .run(`int-${day}`, 'p1', day, 'karim', 'subtle', 'Please rest.', 2, outcome);
  }
  const h = await running(db);
  try {
    assert.equal((await get(h.base, '/api/leaderboard', false)).status, 401);
    const response = await get(h.base, '/api/leaderboard');
    assert.equal(response.status, 200);
    const body = await response.json() as { players: Array<Record<string, unknown>> };
    assert.deepEqual(body.players.map((player) => player.id), ['p1', 'p3', 'p2']);
    const first = body.players[0];
    assert.equal(first.username, 'First');
    assert.equal(first.rank, 1);
    assert.deepEqual(first.statistics, {
      investigations: 2,
      accuracy: 50,
      majorEventsDiscovered: 3,
      successfulInterventions: 1,
      approvedRumors: 0,
    });
    assert.deepEqual(body.players[2].statistics, {
      investigations: 1,
      accuracy: null,
      majorEventsDiscovered: 0,
      successfulInterventions: 0,
      approvedRumors: 0,
    });
    assert.equal(body.players.some((player) => player.id === 'banned'), false);
    assert.deepEqual(Object.keys(first).sort(), ['avatar', 'id', 'influence', 'rank', 'role', 'statistics', 'username']);
  } finally {
    await h.close();
    db.close();
  }
});

test('strict result parsing excludes malformed scoring data and profiles never leak internals', async () => {
  const db = openWorld(':memory:');
  fixture(db);
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('bad', 'p1', 1, '{}', 'submitted', JSON.stringify({ correctEvents: -1, totalEvents: 2, accuracy: -0.5, influenceAwarded: 0, source: 'local' }), new Date().toISOString());
  db.prepare(`INSERT INTO investigations
    (id,player_id,day,answers,status,result,created_at) VALUES (?,?,?,?,?,?,?)`).run('zero', 'p2', 1, '{}', 'submitted', result(0, 0), new Date().toISOString());
  db.prepare(`INSERT INTO interventions
    (id,player_id,day,citizen_id,strength,suggestion,cost,outcome) VALUES (?,?,?,?,?,?,?,?)`).run('accepted', 'p2', 1, 'karim', 'subtle', 'Please rest.', 2, 'accepted');
  const h = await running(db);
  try {
    const profile = await get(h.base, '/api/players/p1');
    assert.equal(profile.status, 200);
    const body = await profile.json() as { player: Record<string, unknown> };
    assert.equal(body.player.username, 'First');
    assert.equal(body.player.statistics && (body.player.statistics as { accuracy: number | null }).accuracy, null);
    assert.equal(JSON.stringify(body).includes('password_hash'), false);
    assert.equal(JSON.stringify(body).includes('answers'), false);
    assert.equal(JSON.stringify(body).includes('correctEvents'), false);
    assert.equal((await get(h.base, '/api/players/banned')).status, 404);
    assert.equal((await get(h.base, '/api/players/unknown')).status, 404);
    assert.equal((await get(h.base, `/api/players/${'x'.repeat(129)}`)).status, 400);
    assert.equal((await get(h.base, '/api/players/p1', false)).status, 401);
  } finally {
    await h.close();
    db.close();
  }
});

test('published final-revision approvals use the frozen voter snapshot and survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wust-players-'));
  const path = join(directory, 'world.db');
  let db = openWorld(`file:${path}`);
  try {
    fixture(db);
    db.prepare(`INSERT INTO rumors
      (id,proposer_id,text,revision,status,proposed_day,expires_at,voter_snapshot) VALUES (?,?,?,?,?,?,?,?)`)
      .run('published-final', 'p1', 'Karim works', 2, 'published', 1, Date.now() + 1000, JSON.stringify(['p1', 'p2']));
    db.prepare(`INSERT INTO rumor_approvals(rumor_id,player_id,revision) VALUES (?,?,?)`).run('published-final', 'p1', 2);
    db.prepare(`INSERT INTO rumors
      (id,proposer_id,text,revision,status,proposed_day,expires_at,voter_snapshot) VALUES (?,?,?,?,?,?,?,?)`)
      .run('stale-version', 'p1', 'Karim works', 2, 'published', 1, Date.now() + 1000, JSON.stringify(['p1']));
    db.prepare(`INSERT INTO rumor_approvals(rumor_id,player_id,revision) VALUES (?,?,?)`).run('stale-version', 'p1', 1);
    db.prepare(`INSERT INTO rumors
      (id,proposer_id,text,revision,status,proposed_day,expires_at,voter_snapshot) VALUES (?,?,?,?,?,?,?,?)`)
      .run('pending', 'p1', 'Karim works', 1, 'pending', 1, Date.now() + 1000, JSON.stringify(['p1']));
    db.prepare(`INSERT INTO rumor_approvals(rumor_id,player_id,revision) VALUES (?,?,?)`).run('pending', 'p1', 1);
    db.prepare('UPDATE players SET influence = 18, username = ?, avatar = 9 WHERE id = ?').run('Renamed', 'p1');
    let h = await running(db);
    const first = await get(h.base, '/api/players/p1');
    const firstBody = await first.json() as { player: Record<string, unknown> };
    assert.equal(firstBody.player.username, 'Renamed');
    assert.equal(firstBody.player.avatar, 9);
    assert.equal((firstBody.player.statistics as { approvedRumors: number }).approvedRumors, 1);
    await h.close();
    db.close();

    db = openWorld(`file:${path}`);
    h = await running(db);
    try {
      const response = await get(h.base, '/api/players/p1');
      const body = await response.json() as { player: Record<string, unknown> };
      assert.equal(body.player.influence, 18);
      assert.equal(body.player.username, 'Renamed');
      assert.equal((body.player.statistics as { approvedRumors: number }).approvedRumors, 1);
    } finally {
      await h.close();
    }
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
