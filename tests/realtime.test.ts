import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../server/src/app.js';
import { openWorld } from '../server/src/db/index.js';
import { SimulationClock } from '../server/src/simulation/clock.js';
import { attachRealtime } from '../server/src/realtime/index.js';
import { projectWorld } from '../server/src/realtime/projection.js';
import { applyDelta } from '../client/src/realtime/reconcile';
import type { WorldDelta, WorldSnapshot } from '../shared/realtime.js';

function event<T>(socket: Socket, name: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 3000);
    socket.once(name, (value: T) => { clearTimeout(timer); resolve(value); });
  });
}
async function fixture() {
  const db = openWorld(':memory:');
  const clock = new SimulationClock(db);
  const server = createServer(createApp(undefined, db));
  const runtime = attachRealtime(server, db, clock);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Socket[] = [];
  async function signup(username: string) {
    const response = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Safe-password-123', confirmPassword: 'Safe-password-123' }) });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  function client(cookie = '', origin?: string) {
    const socket = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } });
    clients.push(socket); return socket;
  }
  async function connect(cookie: string) {
    const socket = client(cookie); const snapshot = event<WorldSnapshot>(socket, 'world:snapshot'); socket.connect();
    return { socket, snapshot: await snapshot };
  }
  return { db, clock, base, signup, client, connect, close: async () => {
    clients.forEach((socket) => socket.disconnect()); clock.stop(); runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve())); db.close();
  } };
}

test('Socket.IO rejects unauthenticated and cross-origin connections', async () => {
  const f = await fixture();
  try {
    const anonymous = f.client(); const denied = event<Error>(anonymous, 'connect_error'); anonymous.connect();
    assert.equal((await denied).message, 'Login required');
    const cookie = await f.signup('Observer');
    const foreign = f.client(cookie, 'https://attacker.example'); const foreignDenied = event<Error>(foreign, 'connect_error'); foreign.connect();
    assert.ok((await foreignDenied).message);
  } finally { await f.close(); }
});

test('six observers see identical committed deltas and public-only citizen state', async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE citizens SET thoughts='HIDDEN INVESTIGATION TRUTH' WHERE id='karim'").run();
    const connected = [];
    for (let i = 0; i < 6; i++) connected.push(await f.connect(await f.signup(`Observer_${i}`)));
    assert.equal(connected.at(-1)!.snapshot.playerCount, 6);
    const deltas = connected.map(({ socket }) => event<WorldDelta>(socket, 'world:delta'));
    const next = f.clock.step(1000);
    const results = await Promise.all(deltas);
    assert.ok(results.every((delta) => delta.version === next.version));
    assert.ok(results.every((delta) => delta.playerCount === 6));
    assert.ok(results.every((delta) => JSON.stringify(delta) === JSON.stringify(results[0])));
    assert.equal(JSON.stringify(connected[0].snapshot).includes('HIDDEN INVESTIGATION TRUTH'), false);
    assert.equal('personality' in connected[0].snapshot.citizens[0], false);
    assert.ok(connected[0].snapshot.citizens[0].appearance.clothing);
    connected[0].socket.emit('world:pause');
    assert.equal(f.clock.step(1000).tick, 2);
  } finally { await f.close(); }
});

test('only successful commits notify; private event content is never broadcast', async () => {
  const f = await fixture();
  try {
    const { socket } = await f.connect(await f.signup('Observer'));
    let notifications = 0;
    socket.on('world:delta', () => { notifications++; });
    assert.throws(() => f.clock.commitCommand('broken', () => { throw new Error('Rollback'); }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notifications, 0);
    const delta = event<WorldDelta>(socket, 'world:delta');
    f.clock.commitCommand('private-update', (db, state) => {
      db.prepare("INSERT INTO events (world_version,game_time_ms,type,importance,visibility,details) VALUES (?,?,?,0,'private',?)")
        .run(state.version + 1, state.game_time_ms, 'secret', JSON.stringify({ text: 'PRIVATE SECRET' }));
      return { ok: true };
    });
    assert.equal(JSON.stringify(await delta).includes('PRIVATE SECRET'), false);
    f.clock.commitCommand('private-update', () => { throw new Error('Should not replay'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notifications, 1);
  } finally { await f.close(); }
});

test('reconnecting gets current state and revoked sessions are disconnected', async () => {
  const f = await fixture();
  try {
    const cookie = await f.signup('Observer');
    const { socket } = await f.connect(cookie);
    socket.disconnect();
    f.clock.step(1000); f.clock.step(1000);
    const snapshot = event<WorldSnapshot>(socket, 'world:snapshot'); socket.connect();
    assert.equal((await snapshot).version, f.clock.state().version);
    await fetch(`${f.base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const disconnected = event<string>(socket, 'disconnect'); f.clock.step(1000);
    assert.equal(await disconnected, 'io server disconnect');
  } finally { await f.close(); }
});

test('the client ignores stale/duplicate deltas and requests resync on gaps', () => {
  const db = openWorld(':memory:');
  try {
    const world = projectWorld(db, 1);
    const delta: WorldDelta = { ...world, previousVersion: 0, version: 1, tick: 1, changes: [], events: [] };
    const next = applyDelta(world, delta);
    assert.equal(next.world!.version, 1);
    assert.equal(next.needsResync, false);
    assert.deepEqual(applyDelta(next.world, delta).world, next.world);
    assert.equal(applyDelta(next.world, { ...delta, version: 3, previousVersion: 2 }).needsResync, true);
    assert.equal(applyDelta(null, delta).needsResync, true);
  } finally { db.close(); }
});
