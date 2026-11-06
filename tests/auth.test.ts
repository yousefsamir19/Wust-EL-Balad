import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/src/app.js';
import { openWorld } from '../server/src/db/index.js';
import { hashPassword, verifyPassword } from '../server/src/auth/password.js';
import type { AddressInfo } from 'node:net';

async function fixture() {
  const db = openWorld(':memory:');
  const server = createApp(undefined, db).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method = 'GET', body?: unknown, cookie = '', headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/auth${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '', body: await res.json(), headers: res.headers };
  }
  return { db, base, request, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); } };
}
const credentials = (username: string) => ({ username, password: 'Safe-password-123', confirmPassword: 'Safe-password-123' });

test('scrypt passwords are salted and checked without storing plaintext', async () => {
  const hash = await hashPassword('Safe-password-123');
  assert.notEqual(hash, await hashPassword('Safe-password-123'));
  assert.equal(await verifyPassword('Safe-password-123', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('anything'), false);
});

test('signup, login, profile rename, avatar, hashed session and logout work', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/me')).status, 401);
    assert.equal((await f.request('/signup', 'POST', { ...credentials('Ahmed'), confirmPassword: 'wrong' })).status, 400);
    const signup = await f.request('/signup', 'POST', credentials('Ahmed'));
    assert.equal(signup.status, 201);
    assert.match(signup.headers.get('set-cookie')!, /HttpOnly/);
    assert.equal(signup.body.player.role, 'player');
    assert.equal('password_hash' in signup.body.player, false);
    assert.equal((await f.request('/signup', 'POST', credentials('ahmed'))).status, 409);
    const stored = f.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    assert.notEqual(stored.token_hash, signup.cookie.split('=')[1]);
    assert.equal((await f.request('/me', 'GET', undefined, signup.cookie)).status, 200);
    const renamed = await f.request('/profile', 'PATCH', { username: 'Ahmed_New', avatar: 7 }, signup.cookie);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.player.id, signup.body.player.id);
    assert.equal(renamed.body.player.avatar, 7);
    assert.equal((await f.request('/profile', 'PATCH', { role: 'admin' }, signup.cookie)).status, 400);
    assert.equal((await f.request('/profile', 'PATCH', { avatar: 10 }, signup.cookie)).status, 400);
    assert.equal((await f.request('/admin/status', 'GET', undefined, signup.cookie)).status, 403);
    assert.equal((await f.request('/logout', 'POST', {}, signup.cookie)).status, 200);
    assert.equal((await f.request('/me', 'GET', undefined, signup.cookie)).status, 401);
    assert.equal((await f.request('/login', 'POST', { username: 'Ahmed_New', password: 'wrong' })).status, 401);
    const login = await f.request('/login', 'POST', credentials('Ahmed_New'));
    assert.equal(login.status, 200);
    f.db.prepare('UPDATE players SET banned = 1 WHERE id = ?').run(signup.body.player.id);
    assert.equal((await f.request('/me', 'GET', undefined, login.cookie)).status, 401);
    assert.equal((await f.request('/login', 'POST', credentials('Ahmed_New'))).status, 401);
  } finally { await f.close(); }
});

test('six simultaneous registrations succeed; seventh is rejected', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => f.request('/signup', 'POST', credentials(`Player_${i}`))));
    assert.equal(results.filter((result) => result.status === 201).length, 6);
    assert.equal(results.filter((result) => result.status === 409).length, 1);
  } finally { await f.close(); }
});

test('admin bootstrap is secret-protected, one-time, and separate from observer slots', async () => {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = 'a-secure-test-secret-with-at-least-32-characters';
  const f = await fixture();
  try {
    assert.equal((await f.request('/admin/bootstrap', 'POST', credentials('HostAdmin'))).status, 403);
    const admin = await f.request('/admin/bootstrap', 'POST', credentials('HostAdmin'), '', { 'x-admin-secret': process.env.ADMIN_SECRET });
    assert.equal(admin.status, 201);
    assert.equal((await f.request('/admin/status', 'GET', undefined, admin.cookie)).status, 200);
    assert.equal((await f.request('/admin/bootstrap', 'POST', credentials('AnotherAdmin'), '', { 'x-admin-secret': process.env.ADMIN_SECRET })).status, 409);
    assert.equal((await f.request('/signup', 'POST', credentials('CrossOrigin'), '', { Origin: 'https://attacker.example' })).status, 403);
    for (let i = 0; i < 6; i++) assert.equal((await f.request('/signup', 'POST', credentials(`Observer_${i}`))).status, 201);
    assert.equal((await f.request('/signup', 'POST', credentials('Observer_7'))).status, 409);
  } finally {
    await f.close();
    if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
  }
});

test('failed logins are rate limited and expired sessions are denied', async () => {
  const f = await fixture();
  try {
    const user = await f.request('/signup', 'POST', credentials('Observer'));
    f.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await f.request('/me', 'GET', undefined, user.cookie)).status, 401);
    for (let i = 0; i < 20; i++) assert.equal((await f.request('/login', 'POST', { username: 'Unknown', password: 'wrong' })).status, 401);
    const response = await fetch(`${f.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Unknown', password: 'wrong' }) });
    assert.equal(response.status, 429);
  } finally { await f.close(); }
});
