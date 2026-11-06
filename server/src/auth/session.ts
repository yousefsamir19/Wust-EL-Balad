import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import type { WorldDatabase } from '../db/index.js';
import type { PlayerProfile } from '../../../shared/auth.js';

export interface PlayerRow extends PlayerProfile { password_hash: string; banned: number }
const lifetime = 7 * 24 * 60 * 60 * 1000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenFrom = (req: Request) => req.headers.cookie?.match(/(?:^|;\s*)wust_session=([a-f0-9]{64})(?:;|$)/)?.[1];
const cookieOptions = () => ({ httpOnly: true, secure: process.env.SESSION_COOKIE_SECURE === 'true', sameSite: 'lax' as const, path: '/' });

export function publicProfile(player: PlayerRow): PlayerProfile {
  return { id: player.id, username: player.username, role: player.role, avatar: player.avatar, influence: player.influence };
}

export function issueSession(db: WorldDatabase, playerId: string, res: Response) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), playerId, Date.now() + lifetime);
  res.cookie('wust_session', token, { ...cookieOptions(), maxAge: lifetime });
}

export function playerFromRequest(db: WorldDatabase, req: Request): PlayerRow | undefined {
  const token = tokenFrom(req);
  if (!token) return undefined;
  return db.prepare(`SELECT p.* FROM players p JOIN sessions s ON s.player_id = p.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND p.banned = 0`).get(digest(token), Date.now()) as PlayerRow | undefined;
}

export function clearSession(db: WorldDatabase, req: Request, res: Response) {
  const token = tokenFrom(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
  res.clearCookie('wust_session', cookieOptions());
}

export function requirePlayer(db: WorldDatabase): RequestHandler {
  return (req, res, next) => {
    const player = playerFromRequest(db, req);
    if (!player) { res.status(401).json({ error: 'Login required' }); return; }
    res.locals.player = player;
    next();
  };
}

export function requireAdmin(db: WorldDatabase): RequestHandler {
  return (req, res, next) => {
    const player = playerFromRequest(db, req);
    if (!player) { res.status(401).json({ error: 'Login required' }); return; }
    if (player.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
    res.locals.player = player;
    next();
  };
}

export const sameOrigin: RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
  const origin = req.get('origin');
  try {
    if ((origin && new URL(origin).host !== req.get('host')) || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return;
    }
  } catch { res.status(403).json({ error: 'Invalid origin' }); return; }
  next();
};
