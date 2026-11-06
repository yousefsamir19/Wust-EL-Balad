import { Router } from 'express';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import type { LeaderboardEntry, LeaderboardResponse, PlayerProfileResponse, PlayerStatistics } from '../../../shared/players.js';

const MAX_ID_LENGTH = 128;
const MAX_INFLUENCE_AWARD = 12;

type PlayerRow = {
  id: string;
  username: string;
  role: 'player' | 'admin';
  avatar: number;
  influence: number;
};

type InvestigationRow = {
  status: string;
  result: string | null;
};

type RumorRow = {
  id: string;
  voterSnapshot: string;
};

type ParsedResult = {
  correctEvents: number;
  totalEvents: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validPlayerId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) return false;
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/**
 * Stored results are internal records, so never trust their derived accuracy or
 * expose their audit payload. The counters are the source of truth for this
 * projection and must describe a finite, bounded result from the scorer.
 */
function parseResult(value: string | null): ParsedResult | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) ||
      !Object.prototype.hasOwnProperty.call(parsed, 'correctEvents') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'totalEvents') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'accuracy') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'influenceAwarded') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'source')) return null;

  const correctEvents = parsed.correctEvents;
  const totalEvents = parsed.totalEvents;
  const accuracy = parsed.accuracy;
  const influenceAwarded = parsed.influenceAwarded;
  if (typeof correctEvents !== 'number' || !Number.isSafeInteger(correctEvents) || correctEvents < 0 ||
      typeof totalEvents !== 'number' || !Number.isSafeInteger(totalEvents) || totalEvents < 0 ||
      correctEvents > totalEvents ||
      typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1 ||
      typeof influenceAwarded !== 'number' || !Number.isFinite(influenceAwarded) ||
      influenceAwarded < 0 || influenceAwarded > MAX_INFLUENCE_AWARD ||
      (parsed.source !== 'local' && parsed.source !== 'network')) return null;

  const expectedAccuracy = totalEvents === 0 ? 0 : correctEvents / totalEvents;
  if (accuracy !== expectedAccuracy) return null;
  return { correctEvents, totalEvents };
}

function snapshotHasPlayer(value: string, playerId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((entry) => {
    if (typeof entry === 'string') return entry === playerId;
    return isRecord(entry) && entry.id === playerId;
  });
}

function profile(player: PlayerRow): Omit<LeaderboardEntry, 'rank' | 'statistics'> {
  return {
    id: player.id,
    username: player.username,
    role: player.role,
    avatar: player.avatar,
    influence: player.influence,
  };
}

function statistics(db: WorldDatabase, playerId: string): PlayerStatistics {
  const investigations = db.prepare(`SELECT status,result FROM investigations
    WHERE player_id = ? AND status = 'submitted'`).all(playerId) as InvestigationRow[];
  let correctEvents = 0;
  let totalEvents = 0;
  for (const investigation of investigations) {
    const result = parseResult(investigation.result);
    if (!result) continue;
    correctEvents += result.correctEvents;
    totalEvents += result.totalEvents;
  }

  const successfulInterventions = (db.prepare(`SELECT COUNT(*) AS count FROM interventions
    WHERE player_id = ? AND outcome = 'accepted'`).get(playerId) as { count: number }).count;

  const rumorRows = db.prepare(`SELECT DISTINCT r.id,r.voter_snapshot AS voterSnapshot
    FROM rumors r JOIN rumor_approvals a ON a.rumor_id = r.id AND a.revision = r.revision
    WHERE r.status = 'published' AND a.player_id = ?`).all(playerId) as RumorRow[];
  const approvedRumors = new Set(rumorRows.filter((row) => snapshotHasPlayer(row.voterSnapshot, playerId)).map((row) => row.id)).size;

  return {
    investigations: investigations.length,
    accuracy: totalEvents > 0 ? 100 * correctEvents / totalEvents : null,
    majorEventsDiscovered: correctEvents,
    successfulInterventions,
    approvedRumors,
  };
}

function entries(db: WorldDatabase): LeaderboardEntry[] {
  const players = db.prepare(`SELECT id,username,role,avatar,influence
    FROM players WHERE banned = 0`).all() as PlayerRow[];
  const withStats = players.map((player) => ({ player, statistics: statistics(db, player.id) }));
  withStats.sort((left, right) => {
    if (right.player.influence !== left.player.influence) return right.player.influence - left.player.influence;
    const leftAccuracy = left.statistics.accuracy;
    const rightAccuracy = right.statistics.accuracy;
    if (leftAccuracy === null && rightAccuracy !== null) return 1;
    if (leftAccuracy !== null && rightAccuracy === null) return -1;
    if (leftAccuracy !== rightAccuracy) return (rightAccuracy ?? 0) - (leftAccuracy ?? 0);
    if (right.statistics.majorEventsDiscovered !== left.statistics.majorEventsDiscovered) {
      return right.statistics.majorEventsDiscovered - left.statistics.majorEventsDiscovered;
    }
    return left.player.id < right.player.id ? -1 : left.player.id > right.player.id ? 1 : 0;
  });
  return withStats.map(({ player, statistics: playerStatistics }, index) => ({
    ...profile(player),
    rank: index + 1,
    statistics: playerStatistics,
  }));
}

export function leaderboardRouter(db: WorldDatabase): Router {
  const router = Router();
  router.use(requirePlayer(db));
  router.get('/', (_req, res) => {
    const response: LeaderboardResponse = { players: entries(db) };
    res.json(response);
  });
  return router;
}

export function playerProfilesRouter(db: WorldDatabase): Router {
  const router = Router();
  router.use(requirePlayer(db));
  router.get('/:id', (req, res) => {
    if (!validPlayerId(req.params.id)) {
      res.status(400).json({ error: 'Invalid player id.' });
      return;
    }
    const player = db.prepare(`SELECT id,username,role,avatar,influence
      FROM players WHERE id = ? AND banned = 0`).get(req.params.id) as PlayerRow | undefined;
    if (!player) {
      res.status(404).json({ error: 'Player not found.' });
      return;
    }
    const all = entries(db);
    const result = all.find((entry) => entry.id === player.id);
    if (!result) {
      res.status(404).json({ error: 'Player not found.' });
      return;
    }
    const response: PlayerProfileResponse = { player: result };
    res.json(response);
  });
  return router;
}
