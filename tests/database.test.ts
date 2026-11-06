import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorld } from '../server/src/db/index.js';
import { migrate } from '../server/src/db/migrations.js';
import { seed } from '../server/src/db/seed.js';
import { createApp } from '../server/src/app.js';
import type { AddressInfo } from 'node:net';

test('migrations and seed are idempotent, with ten complete citizens and directed relationships', () => {
  const db = openWorld(':memory:');
  try {
    migrate(db); seed(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM citizens').get() as { n: number }).n, 10);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM relationships').get() as { n: number }).n, 90);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM buildings').get() as { n: number }).n, 16);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number }).n, 10);
    assert.equal(db.pragma('foreign_key_check').length, 0);
    const citizen = db.prepare('SELECT * FROM citizens WHERE id = ?').get('karim') as Record<string, unknown>;
    assert.equal(citizen.name, 'Karim');
    assert.equal(JSON.parse(citizen.needs as string).energy, 85);
    assert.throws(() => db.transaction(() => {
      db.prepare('UPDATE citizens SET money = money + 100 WHERE id = ?').run('karim');
      throw new Error('interrupt');
    })());
    assert.equal((db.prepare('SELECT money FROM citizens WHERE id = ?').get('karim') as { money: number }).money, 60000);
  } finally { db.close(); }
});

test('world state survives reopening without reseeding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wust-db-'));
  try {
    const file = join(directory, 'world.db');
    let db = openWorld(file);
    db.prepare('UPDATE world SET game_time_ms = 90000000, version = 7 WHERE id = 1').run();
    db.prepare('UPDATE citizens SET money = 12345 WHERE id = ?').run('karim');
    db.close();
    db = openWorld(file);
    assert.equal((db.prepare('SELECT version FROM world').get() as { version: number }).version, 7);
    assert.equal((db.prepare('SELECT money FROM citizens WHERE id = ?').get('karim') as { money: number }).money, 12345);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('world summary contains counts, not private citizens or secrets', async () => {
  const db = openWorld(':memory:');
  const server = createApp(undefined, db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/world/summary`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.citizenCount, 10);
    assert.equal(body.currency, 'EGP');
    assert.equal(body.day, 1);
    assert.equal('citizens' in body, false);
    assert.equal('secrets' in body, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
