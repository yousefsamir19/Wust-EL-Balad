import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openWorld } from '../server/src/db/index.js';
import { GAME_DAY_MS, SimulationClock } from '../server/src/simulation/clock.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('six-hour game day scale and transactional tick persistence', () => {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db, { dayDurationHours: 6 });
  try {
    const previous = clock.state();
    const next = clock.step(1000);
    assert.equal(next.game_time_ms, previous.game_time_ms + 4000);
    assert.equal(next.tick, previous.tick + 1);
    assert.equal(next.version, previous.version + 1);
    assert.deepEqual(clock.state(), next);
    assert.throws(() => clock.step(-1));
  } finally { clock.stop(); db.close(); }
});

test('day closure is recorded once with its exact boundary', () => {
  const db = openWorld(':memory:');
  db.prepare('UPDATE world SET game_time_ms = ?').run(GAME_DAY_MS - 1000);
  const clock = new SimulationClock(db, { dayDurationHours: 6 });
  try {
    clock.step(1000); clock.step(1000);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM closed_days').get() as { n: number }).n, 1);
    const boundary = db.prepare('SELECT * FROM closed_days').get() as { day: number; closed_game_ms: number };
    assert.equal(boundary.day, 1);
    assert.equal(boundary.closed_game_ms, GAME_DAY_MS);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'day_ended'").get() as { n: number }).n, 1);
  } finally { clock.stop(); db.close(); }
});

test('commands are atomic and replaying an id does not spend money twice', () => {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db);
  const previous = clock.state();
  const amount = () => (db.prepare("SELECT money FROM citizens WHERE id = 'karim'").get() as { money: number }).money;
  try {
    assert.throws(() => clock.commitCommand('failing', (database) => {
      database.prepare("UPDATE citizens SET money = money - 100 WHERE id = 'karim'").run();
      throw new Error('Interrupted');
    }));
    assert.equal(amount(), 60000);
    assert.deepEqual(clock.state(), previous);
    const action = () => { db.prepare("UPDATE citizens SET money = money - 100 WHERE id = 'karim'").run(); return { ok: true }; };
    assert.deepEqual(clock.commitCommand('purchase', action), { ok: true });
    assert.deepEqual(clock.commitCommand('purchase', action), { ok: true });
    assert.equal(amount(), 59900);
    assert.equal(clock.state().version, previous.version + 1);
  } finally { clock.stop(); db.close(); }
});

test('a second writer is rejected, and an expired lease cannot keep writing after takeover', () => {
  const db = openWorld(':memory:');
  const first = new SimulationClock(db);
  try {
    assert.throws(() => new SimulationClock(db), /active simulation/);
    db.prepare('UPDATE simulation_lock SET expires_at = 0').run();
    const second = new SimulationClock(db);
    try {
      assert.throws(() => first.step(1000), /lost its writer lease/);
      first.stop();
      assert.equal(second.step(1000).tick, 1);
    } finally { second.stop(); }
  } finally { first.stop(); db.close(); }
});

test('the clock ticks with no players; stopping freezes logical time', async () => {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db, { tickMs: 20 });
  try {
    clock.start();
    await wait(100);
    clock.stop();
    const stopped = clock.state();
    assert.ok(stopped.tick > 0);
    await wait(50);
    assert.deepEqual(clock.state(), stopped);
  } finally { clock.stop(); db.close(); }
});

test('production startup resumes saved time without advancing across actual server downtime', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wust-clock-'));
  const file = join(directory, 'world.db');
  const base = 'http://127.0.0.1:3014';
  let child: ReturnType<typeof spawn> | undefined;
  async function start() {
    child = spawn(process.execPath, ['dist/server/server/src/index.js'], {
      env: { ...process.env, PORT: '3014', DATABASE_URL: `file:${file}`, SIMULATION_TICK_MS: '1000', DAY_DURATION_HOURS: '6' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr?.on('data', (data) => { output += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const res = await fetch(`${base}/api/world/summary`); if (res.ok) return await res.json(); } catch { /* startup */ }
      await wait(50);
    }
    throw new Error('Production startup timed out');
  }
  async function stop() {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child!.once('exit', resolve));
    }
  }
  try {
    const first = await start();
    await wait(1150);
    const current = await (await fetch(`${base}/api/world/summary`)).json();
    assert.ok(current.tick > first.tick);
    await stop();
    await wait(150);
    const resumed = await start();
    assert.equal(resumed.tick, current.tick);
    assert.equal(resumed.minute, current.minute);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
