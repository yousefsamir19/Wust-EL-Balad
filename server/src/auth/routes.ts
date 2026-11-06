import { Router, type Request, type Response, type RequestHandler, type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { clearSession, issueSession, playerFromRequest, publicProfile, requireAdmin, requirePlayer, type PlayerRow } from './session.js';

class InputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void fn(req, res).catch(next); };
const validUsername = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{3,24}$/.test(value);
function registration(body: Record<string, unknown>) {
  if (!validUsername(body.username)) throw new InputError(400, 'Username must be 3–24 letters, numbers, or underscores');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) throw new InputError(400, 'Password must be 10–128 characters');
  if (body.confirmPassword !== body.password) throw new InputError(400, 'Passwords must match');
  return { username: body.username, password: body.password };
}

export function authRouter(db: WorldDatabase) {
  const router = Router();
  const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many attempts. Please wait and try again.' } });
  router.use(['/signup', '/login', '/admin/bootstrap'], limit);
  async function createAccount(req: Request, res: Response, role: 'player' | 'admin') {
    const { username, password } = registration(req.body ?? {});
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    db.transaction(() => {
      if (role === 'player') {
        const count = db.prepare("SELECT COUNT(*) AS n FROM players WHERE role = 'player' AND banned = 0").get() as { n: number };
        if (count.n >= 6) throw new InputError(409, 'The world already has six registered players');
      } else if (db.prepare("SELECT id FROM players WHERE role = 'admin'").get()) {
        throw new InputError(409, 'An administrator already exists');
      }
      if (db.prepare('SELECT id FROM players WHERE username = ?').get(username)) throw new InputError(409, 'Username is already taken');
      db.prepare('INSERT INTO players (id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)')
        .run(id, username, passwordHash, role, new Date().toISOString());
      issueSession(db, id, res);
    })();
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow;
    res.status(201).json({ player: publicProfile(player) });
  }
  router.post('/signup', asyncRoute((req, res) => createAccount(req, res, 'player')));
  router.post('/admin/bootstrap', asyncRoute(async (req, res) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || secret.length < 32) throw new InputError(503, 'Admin bootstrap is disabled; configure a strong ADMIN_SECRET');
    const supplied = req.get('x-admin-secret') ?? '';
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InputError(403, 'Admin bootstrap denied');
    await createAccount(req, res, 'admin');
  }));
  router.post('/login', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    if (!validUsername(body.username) || typeof body.password !== 'string' || body.password.length > 128) throw new InputError(401, 'Invalid username or password');
    const player = db.prepare('SELECT * FROM players WHERE username = ?').get(body.username) as PlayerRow | undefined;
    const valid = await verifyPassword(body.password, player?.password_hash);
    if (!player || !valid || player.banned) throw new InputError(401, 'Invalid username or password');
    issueSession(db, player.id, res);
    res.json({ player: publicProfile(player) });
  }));
  router.get('/me', requirePlayer(db), (_req, res) => {
    res.json({ player: publicProfile(res.locals.player as PlayerRow) });
  });
  router.patch('/profile', requirePlayer(db), (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (Object.keys(body).some((key) => !['username', 'avatar'].includes(key))) throw new InputError(400, 'Only username and avatar can be updated');
      const player = res.locals.player as PlayerRow;
      const username = body.username ?? player.username;
      const avatar = body.avatar ?? player.avatar;
      if (!validUsername(username)) throw new InputError(400, 'Invalid username');
      if (!Number.isInteger(avatar) || avatar < 0 || avatar > 9) throw new InputError(400, 'Invalid avatar');
      const existing = db.prepare('SELECT id FROM players WHERE username = ? AND id != ?').get(username, player.id);
      if (existing) throw new InputError(409, 'Username is already taken');
      db.prepare('UPDATE players SET username = ?, avatar = ? WHERE id = ?').run(username, avatar, player.id);
      res.json({ player: publicProfile({ ...player, username, avatar }) });
    } catch (error) { next(error); }
  });
  router.post('/logout', (req, res) => { clearSession(db, req, res); res.json({ ok: true }); });
  router.get('/admin/status', requireAdmin(db), (_req, res) => { res.json({ authorized: true }); });
  router.use(((error: Error, _req, res, _next) => {
    if (error instanceof InputError) res.status(error.status).json({ error: error.message });
    else res.status(500).json({ error: 'Authentication operation failed' });
  }) as ErrorRequestHandler);
  return router;
}

export { playerFromRequest };
