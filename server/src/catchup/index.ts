import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import { InvestigationError, type InvestigationService } from '../investigations/service.js';
import type { CatchUpBoard, CatchUpDay } from '../../../shared/catchup.js';

const GAME_DAY_MS = 86_400_000;
const PAGE_SIZE = 50;

type PlayerVisitRow = { lastSeenGameMs: number | null };
type PlayerReturnRow = { fromGameMs: number };
type ClosedDayRow = { day: number; closedGameMs: number; headline: string | null; newspaperReady: number };

type InvestigationStatus = 'open' | 'pending' | 'submitted' | 'skipped';

function assertGameTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid game time');
}

/** Record a socket-era visit without advancing the simulation clock or world version. */
export function recordVisit(db: WorldDatabase, playerId: string, gameTimeMs: number): void {
  assertGameTime(gameTimeMs);
  if (typeof playerId !== 'string' || !playerId) throw new Error('Invalid player');
  db.transaction(() => {
    const player = db.prepare('SELECT last_seen_game_ms AS lastSeenGameMs FROM players WHERE id=?').get(playerId) as PlayerVisitRow | undefined;
    if (!player) return;
    if (player.lastSeenGameMs !== null && player.lastSeenGameMs === gameTimeMs) return;
    const previousSeen = player.lastSeenGameMs;
    db.prepare('INSERT INTO player_visits(player_id,seen_game_ms,previous_seen_game_ms) VALUES(?,?,?)')
      .run(playerId, gameTimeMs, previousSeen);
    db.prepare('UPDATE players SET last_seen_game_ms=? WHERE id=?').run(gameTimeMs, playerId);
    db.prepare('INSERT OR IGNORE INTO player_returns(player_id,from_game_ms) VALUES(?,?)')
      .run(playerId, previousSeen ?? 0);
  })();
}

/** Refresh active players' last-seen metadata only; this never changes return windows. */
export function markSeen(db: WorldDatabase, playerIds: string[], gameTimeMs: number): void {
  assertGameTime(gameTimeMs);
  if (!Array.isArray(playerIds)) throw new Error('Invalid players');
  const unique = [...new Set(playerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  db.transaction(() => {
    const update = db.prepare('UPDATE players SET last_seen_game_ms=? WHERE id=?');
    for (const playerId of unique) update.run(gameTimeMs, playerId);
  })();
}

function positiveDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const day = Number(value);
  return Number.isSafeInteger(day) && day > 0 ? day : null;
}

function currentDay(db: WorldDatabase): number {
  const row = db.prepare('SELECT game_time_ms AS gameTimeMs FROM world WHERE id=1').get() as { gameTimeMs: number };
  return Math.floor(row.gameTimeMs / GAME_DAY_MS) + 1;
}

function returnFrom(db: WorldDatabase, playerId: string): number {
  const row = db.prepare('SELECT from_game_ms AS fromGameMs FROM player_returns WHERE player_id=?').get(playerId) as PlayerReturnRow | undefined;
  return row?.fromGameMs ?? 0;
}

function closedDayFor(db: WorldDatabase, playerId: string, day: number, nowDay: number): boolean {
  const row = db.prepare('SELECT closed_game_ms AS closedGameMs FROM closed_days WHERE day=?').get(day) as { closedGameMs: number } | undefined;
  return !!row && day < nowDay && row.closedGameMs > returnFrom(db, playerId);
}

function headlineFrom(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { headline?: unknown }).headline === 'string'
      ? (parsed as { headline: string }).headline
      : null;
  } catch {
    return null;
  }
}

function investigationStatus(db: WorldDatabase, playerId: string, day: number): InvestigationStatus {
  const row = db.prepare('SELECT status FROM investigations WHERE player_id=? AND day=?').get(playerId, day) as { status?: string } | undefined;
  return row?.status === 'pending' || row?.status === 'submitted' || row?.status === 'skipped' ? row.status : 'open';
}

function reviewed(db: WorldDatabase, playerId: string, day: number): boolean {
  return !!db.prepare('SELECT 1 FROM player_reviewed_days WHERE player_id=? AND day=?').get(playerId, day);
}

function board(db: WorldDatabase, playerId: string, beforeDay: number | null = null): CatchUpBoard {
  const nowDay = currentDay(db);
  const fromGameMs = returnFrom(db, playerId);
  const rows = db.prepare(`SELECT c.day,c.closed_game_ms AS closedGameMs,a.newspaper,
      CASE WHEN a.day IS NULL THEN 0 ELSE 1 END AS newspaperReady
    FROM closed_days c LEFT JOIN day_archives a ON a.day=c.day
    WHERE c.closed_game_ms>? AND c.day<? ${beforeDay === null ? '' : 'AND c.day<?'}
    ORDER BY c.day DESC LIMIT ?`).all(...(beforeDay === null ? [fromGameMs, nowDay, PAGE_SIZE + 1] : [fromGameMs, nowDay, beforeDay, PAGE_SIZE + 1])) as Array<ClosedDayRow & { newspaper: string | null }>;
  const hasMore = rows.length > PAGE_SIZE;
  const selected = rows.slice(0, PAGE_SIZE);
  const eventCount = db.prepare(`SELECT COUNT(*) AS count FROM events
    WHERE visibility='public' AND game_time_ms>=? AND game_time_ms<?`);
  const conversationCount = db.prepare(`SELECT COUNT(*) AS count FROM conversations
    WHERE visibility='public' AND game_time_ms>=? AND game_time_ms<?`);
  const days: CatchUpDay[] = selected.map((row) => {
    const start = (row.day - 1) * GAME_DAY_MS;
    const end = row.day * GAME_DAY_MS;
    return {
      day: row.day,
      headline: headlineFrom(row.newspaper),
      newspaperReady: row.newspaperReady === 1,
      publicEvents: Number((eventCount.get(start, end) as { count: number }).count),
      conversations: Number((conversationCount.get(start, end) as { count: number }).count),
      investigationStatus: investigationStatus(db, playerId, row.day),
      reviewed: reviewed(db, playerId, row.day),
    };
  });
  return { currentDay: nowDay, fromGameMs, days, hasMore };
}

function validEmptyBody(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function mutationError(error: unknown): { status: number; message: string } {
  if (error instanceof InvestigationError) {
    if (error.code === 'invalid') return { status: 400, message: 'Invalid catch-up request.' };
    if (error.code === 'not_found') return { status: 404, message: 'Catch-up day not found.' };
    if (error.code === 'conflict') return { status: 409, message: 'This investigation is already finalized.' };
    if (error.code === 'unauthorized') return { status: 401, message: 'Login required.' };
  }
  return { status: 503, message: 'Catch-up is unavailable.' };
}

function reviewDay(db: WorldDatabase, playerId: string, day: number): void {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO player_reviewed_days(player_id,day) VALUES(?,?)').run(playerId, day);
  })();
}

export function catchUpRouter(db: WorldDatabase, investigations?: InvestigationService): Router {
  const router = Router();
  router.use(requirePlayer(db));
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (_req, res) => String(res.locals.player.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many catch-up mutations. Please wait.' }),
  });

  router.get('/', (req, res) => {
    const now = currentDay(db);
    let beforeDay: number | null = null;
    if (req.query.beforeDay !== undefined) {
      beforeDay = positiveDay(req.query.beforeDay);
      if (beforeDay === null || beforeDay > now) { res.status(400).json({ error: 'Invalid day cursor' }); return; }
    }
    try { res.json(board(db, String(res.locals.player.id), beforeDay)); }
    catch { res.status(503).json({ error: 'Catch-up is unavailable.' }); }
  });

  router.post('/:day/review', limiter, (req, res) => {
    const day = positiveDay(req.params.day);
    const playerId = String(res.locals.player.id);
    if (day === null || !validEmptyBody(req.body)) { res.status(400).json({ error: 'An empty request body is required.' }); return; }
    if (!closedDayFor(db, playerId, day, currentDay(db))) { res.status(404).json({ error: 'Catch-up day not found.' }); return; }
    try {
      reviewDay(db, playerId, day);
      res.json(board(db, playerId));
    } catch { res.status(503).json({ error: 'Catch-up is unavailable.' }); }
  });

  router.post('/:day/skip', limiter, (req, res) => {
    const day = positiveDay(req.params.day);
    const playerId = String(res.locals.player.id);
    if (day === null || !validEmptyBody(req.body)) { res.status(400).json({ error: 'An empty request body is required.' }); return; }
    if (!investigations) { res.status(503).json({ error: 'Catch-up investigations are unavailable.' }); return; }
    if (!closedDayFor(db, playerId, day, currentDay(db))) { res.status(404).json({ error: 'Catch-up day not found.' }); return; }
    try {
      investigations.skip(playerId, day);
      reviewDay(db, playerId, day);
      res.json(board(db, playerId));
    } catch (error) {
      const mapped = mutationError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  return router;
}
