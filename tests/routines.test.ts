import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openWorld } from '../server/src/db/index.js';
import { SimulationClock } from '../server/src/simulation/clock.js';
import { findPath, walkable, tileKey } from '../server/src/simulation/navigation.js';
import { chooseUtility, contextualDialogue } from '../server/src/citizens/routines.js';
import type { TilePoint, TownBuilding, VisibleCitizen } from '../shared/world.js';

type Citizen = Parameters<typeof chooseUtility>[0];
const getCitizen = (db: ReturnType<typeof openWorld>, id: string) => db.prepare('SELECT * FROM citizens WHERE id = ?').get(id) as Citizen;
const getRoutine = (db: ReturnType<typeof openWorld>, id: string) => db.prepare('SELECT * FROM citizen_routines WHERE citizen_id = ?').get(id) as { goal_action: string; target_building_id: string; path: string };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db, { dayDurationHours: 6 });
  return { db, clock, close: () => { clock.stop(); db.close(); } };
}

test('pathfinding respects map bounds, water, buildings, and occupied tiles', () => {
  const db = openWorld(':memory:');
  try {
    const buildings = db.prepare('SELECT * FROM buildings').all() as TownBuilding[];
    const start = { x: 0, y: 0 };
    const goal = { x: 20, y: 20 };
    const occupied = new Set(['1,0', '0,1']);
    assert.equal(findPath(start, goal, buildings, occupied), null);
    const path = findPath(start, goal, buildings)!;
    assert.ok(path.length > 0);
    let previous = start;
    for (const point of path) {
      assert.equal(walkable(point, buildings), true);
      assert.equal(Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y), 1);
      previous = point;
    }
    assert.deepEqual(path.at(-1), goal);
    assert.equal(findPath(start, { x: 30, y: 10 }, buildings), null);
    assert.equal(findPath(start, { x: 75, y: 5 }, buildings), null);
    assert.equal(findPath(start, { x: -1, y: 0 }, buildings), null);
    assert.deepEqual(findPath(start, start, buildings), []);
  } finally { db.close(); }
});

test('needs and schedules select work, food, sleep, and social activity without an API', () => {
  const db = openWorld(':memory:');
  try {
    const citizen = getCitizen(db, 'karim');
    const schedule = { shift_start: 480, shift_end: 1020 };
    assert.equal(chooseUtility(citizen, { hunger: 10, energy: 90, social: 10 }, 600, schedule).action, 'work');
    assert.equal(chooseUtility(citizen, { hunger: 99, energy: 90, social: 10 }, 600, schedule).action, 'eat');
    assert.equal(chooseUtility(citizen, { hunger: 10, energy: 1, social: 10 }, 600, schedule).action, 'sleep');
    assert.equal(chooseUtility(citizen, { hunger: 10, energy: 90, social: 99 }, 600, schedule).action, 'socialize');
    assert.equal(chooseUtility(citizen, { hunger: 10, energy: 90, social: 10 }, 1380, schedule).action, 'sleep');
    assert.equal(chooseUtility(citizen, { hunger: 10, energy: 90, social: 10 }, 1100, schedule).action, 'idle');
  } finally { db.close(); }
});

test('ten citizens move legally without overlap and save paths, activities, and needs', () => {
  const f = fixture();
  try {
    const buildings = f.db.prepare('SELECT * FROM buildings').all() as TownBuilding[];
    const initial = new Map((f.db.prepare('SELECT id,x,y FROM citizens').all() as (TilePoint & { id: string })[]).map((citizen) => [citizen.id, tileKey(citizen)]));
    for (let i = 0; i < 100; i++) {
      f.clock.step(1000);
      const current = f.db.prepare('SELECT id,x,y FROM citizens').all() as (TilePoint & { id: string })[];
      assert.equal(new Set(current.map(tileKey)).size, 10);
      for (const citizen of current) assert.equal(walkable(citizen, buildings), true);
    }
    const current = f.db.prepare('SELECT id,x,y FROM citizens').all() as (TilePoint & { id: string })[];
    assert.ok(current.filter((citizen) => initial.get(citizen.id) !== tileKey(citizen)).length >= 8);
    assert.ok((f.db.prepare("SELECT COUNT(*) AS n FROM citizens WHERE activity IN ('working','socializing','idle','eating')").get() as { n: number }).n > 0);
    assert.ok(JSON.parse(getCitizen(f.db, 'karim').needs).hunger > 15);
    assert.equal(f.clock.state().tick, 100);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number }).n, 10);
  } finally { f.close(); }
});

test('eating restores hunger and social conversation templates use actual state', () => {
  const f = fixture();
  try {
    const cafe = f.db.prepare("SELECT * FROM buildings WHERE id = 'cafe'").get() as TownBuilding;
    f.db.prepare("UPDATE citizens SET x=?,y=?,building_id='cafe',activity='eating',needs=? WHERE id='karim'")
      .run(cafe.door_x, cafe.door_y, JSON.stringify({ hunger: 80, energy: 90, social: 10 }));
    f.db.prepare("UPDATE citizen_routines SET goal_action='eat',target_building_id='cafe',next_decision_game_ms=99999999 WHERE citizen_id='karim'").run();
    f.clock.step(60000);
    const citizen = getCitizen(f.db, 'karim');
    assert.ok(JSON.parse(citizen.needs).hunger < 80);
    const other = getCitizen(f.db, 'laila');
    assert.match(contextualDialogue({ ...citizen, money: 1000 }, other, { hunger: 0, energy: 90, social: 10 }, 70), /EGP/);
    assert.match(contextualDialogue(citizen, other, { hunger: 0, energy: 90, social: 10 }, 10), /personal worries/);
    const square = f.db.prepare("SELECT * FROM buildings WHERE id='square'").get() as TownBuilding;
    for (const [index, id] of ['dina', 'hassan'].entries()) {
      f.db.prepare("UPDATE citizens SET x=?,y=?,building_id='square',activity='socializing',needs=? WHERE id=?")
        .run(square.door_x + index, square.door_y, JSON.stringify({ hunger: 0, energy: 90, social: 95 }), id);
      f.db.prepare("UPDATE citizen_routines SET goal_action='socialize',target_building_id='square',path='[]',next_decision_game_ms=99999999 WHERE citizen_id=?").run(id);
    }
    f.clock.step(1000);
    assert.ok((f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n > 0);
  } finally { f.close(); }
});

test('an unreachable town does not freeze or teleport citizens', () => {
  const f = fixture();
  try {
    const previous = f.db.prepare('SELECT id,x,y FROM citizens ORDER BY id').all();
    f.db.prepare('INSERT INTO buildings VALUES (?,?,?,?,?,?,?,?,?)').run('blocked-world', 'Test obstacle', 'wall', 0, 0, 80, 64, 0, 0);
    f.clock.step(1000);
    assert.equal(f.clock.state().tick, 1);
    assert.deepEqual(f.db.prepare('SELECT id,x,y FROM citizens ORDER BY id').all(), previous);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM citizens WHERE activity='blocked'").get() as { n: number }).n, 10);
  } finally { f.close(); }
});

test('movement, needs, events, and clock roll back together if a commit fails', () => {
  const f = fixture();
  try {
    const previous = f.db.prepare('SELECT * FROM citizens ORDER BY id').all();
    f.db.exec("CREATE TRIGGER reject_tick BEFORE UPDATE ON world BEGIN SELECT RAISE(ABORT,'test disk failure'); END;");
    assert.throws(() => f.clock.step(1000));
    assert.deepEqual(f.db.prepare('SELECT * FROM citizens ORDER BY id').all(), previous);
    assert.equal(f.clock.state().tick, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test('paths and activity resume from disk without reseeding on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wust-routine-'));
  try {
    const file = join(directory, 'world.db');
    let db = openWorld(file);
    let clock = new SimulationClock(db);
    clock.step(1000);
    const citizen = getCitizen(db, 'karim');
    const routine = getRoutine(db, 'karim');
    assert.ok(JSON.parse(routine.path).length > 0);
    clock.stop(); db.close();
    db = openWorld(file);
    assert.deepEqual(getCitizen(db, 'karim'), citizen);
    assert.deepEqual(getRoutine(db, 'karim'), routine);
    clock = new SimulationClock(db);
    clock.step(1000);
    assert.notEqual(tileKey(getCitizen(db, 'karim')), tileKey(citizen));
    clock.stop(); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production simulation moves with no AI keys and serves only authenticated public citizen fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wust-zero-api-'));
  const child = spawn(process.execPath, ['dist/server/server/src/index.js'], {
    env: { ...process.env, PORT: '3015', DATABASE_URL: `file:${join(directory, 'world.db')}`, GEMINI_API_KEY: '', OPENAI_API_KEY: '', DAY_DURATION_HOURS: '6', SIMULATION_TICK_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = 'http://127.0.0.1:3015';
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(errors);
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* startup */ }
      await wait(50);
    }
    assert.ok(ready, errors);
    assert.equal((await fetch(`${base}/api/world/citizens`)).status, 401);
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Observer', password: 'Safe-password-123', confirmPassword: 'Safe-password-123' }),
    });
    assert.equal(signup.status, 201);
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const snapshot = async () => await (await fetch(`${base}/api/world/citizens`, { headers: { Cookie: cookie } })).json() as { tick: number; citizens: VisibleCitizen[] };
    const before = await snapshot();
    await wait(1250);
    const after = await snapshot();
    assert.equal(after.citizens.length, 10);
    assert.ok(after.tick > before.tick);
    assert.ok(after.citizens.some((citizen, index) => tileKey(citizen) !== tileKey(before.citizens[index])));
    for (const citizen of after.citizens) {
      for (const hidden of ['thoughts', 'memories', 'secrets', 'personality', 'password_hash']) assert.equal(hidden in citizen, false);
    }
    assert.equal((await fetch(`${base}/api/world/pause`, { method: 'POST', headers: { Cookie: cookie } })).status, 404);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
