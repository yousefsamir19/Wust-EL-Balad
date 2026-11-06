import { createHash, randomUUID } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import { GAME_DAY_MS, type SimulationClock, type WorldState } from '../simulation/clock.js';
import { expireRumors, publishRumor } from './engine.js';
import type { RumorBoard, RumorRecord } from '../../../shared/rumors.js';

type CommandClock = Pick<SimulationClock, 'state' | 'commitCommand'>;
type ErrorCode = 'invalid' | 'unauthorized' | 'not_found' | 'conflict' | 'unavailable';
type Player = { id: string; username: string; banned: number };
type RumorRow = {
  id: string; proposerId: string; proposerName: string; text: string; revision: number;
  status: 'pending' | 'published' | 'expired'; proposedDay: number; expiresAt: number;
  publishedGameMs: number | null; publishedEventId: number | null; voterSnapshot: string;
};
type Voter = { id: string; username: string; approved: boolean };

const DAY = GAME_DAY_MS;
const DEADLINE = 24 * 60 * 60 * 1000;
const MAX_TEXT = 240;

export class RumorError extends Error {
  constructor(public readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'RumorError';
  }
}

function dayFor(gameTimeMs: number): number {
  return Math.floor(gameTimeMs / DAY) + 1;
}

function assertDb(db: WorldDatabase): void {
  try {
    if (!db.open) throw new Error('closed');
  } catch {
    throw new RumorError('unavailable');
  }
}

function assertPlayer(db: WorldDatabase, playerId: string): Player {
  if (typeof playerId !== 'string' || !playerId || playerId.length > 256) throw new RumorError('invalid');
  const player = db.prepare('SELECT id,username,banned FROM players WHERE id = ?').get(playerId) as Player | undefined;
  if (!player || player.banned !== 0) throw new RumorError('unauthorized');
  return player;
}

function assertId(id: unknown): string {
  if (typeof id !== 'string' || !id || id.length > 256 || Array.from(id).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) throw new RumorError('invalid', 'id');
  return id;
}

function assertRevision(revision: unknown): number {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new RumorError('invalid', 'revision');
  return revision;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsKnownEntity(db: WorldDatabase, text: string): boolean {
  const names = db.prepare(`SELECT name FROM citizens UNION SELECT name FROM buildings WHERE type <> 'house'`).all() as { name: string }[];
  return names.some(({ name }) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(text));
}

function normalizeText(db: WorldDatabase, value: unknown): string {
  if (typeof value !== 'string') throw new RumorError('invalid', 'text');
  const text = value.trim();
  if (!text || Array.from(text).length > MAX_TEXT || /[<>]/.test(text) || Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) throw new RumorError('invalid', 'text');
  if (/(?:https?:\/\/|www\.|ftp:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(text) || /(?:^|\D)(?:\+?\d[\d .()\d-]{6,}\d)(?:\D|$)/u.test(text)) {
    throw new RumorError('invalid', 'text');
  }
  if (/\b(?:password|passcode|token|api[ -]?key|secret key|bearer)\b/iu.test(text) ||
      /\b(?:how to|instructions?|steps? to|make|build|create)\b[^.!?]{0,48}\b(?:bomb|explosive|weapon|poison|kill|attack)\b/iu.test(text)) {
    throw new RumorError('invalid', 'text');
  }
  if (!containsKnownEntity(db, text)) throw new RumorError('invalid', 'text');
  return text;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function commandId(kind: string, playerId: string, rumorId: string, revision: number, text = ''): string {
  const id = `rumor:${kind}:${playerId}:${rumorId}:${revision}:${hash(text)}`;
  if (id.length > 128) throw new RumorError('invalid');
  return id;
}

function rows(db: WorldDatabase): RumorRow[] {
  return db.prepare(`SELECT r.id,r.proposer_id AS proposerId,p.username AS proposerName,r.text,r.revision,r.status,
      r.proposed_day AS proposedDay,r.expires_at AS expiresAt,r.published_game_ms AS publishedGameMs,
      r.published_event_id AS publishedEventId,r.voter_snapshot AS voterSnapshot
    FROM rumors r JOIN players p ON p.id = r.proposer_id ORDER BY r.rowid DESC LIMIT 20`).all() as RumorRow[];
}

function snapshotIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => typeof entry === 'string' ? entry :
      entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '').filter(Boolean);
  } catch {
    return [];
  }
}

function eligibleVoters(db: WorldDatabase): Player[] {
  return db.prepare('SELECT id,username,banned FROM players WHERE banned = 0 ORDER BY rowid').all() as Player[];
}

function approvalIds(db: WorldDatabase, rumorId: string, revision: number): Set<string> {
  return new Set((db.prepare('SELECT player_id AS id FROM rumor_approvals WHERE rumor_id = ? AND revision = ?').all(rumorId, revision) as { id: string }[]).map((row) => row.id));
}

function record(db: WorldDatabase, row: RumorRow): RumorRecord {
  const approvals = approvalIds(db, row.id, row.revision);
  const voters: Voter[] = row.status === 'published'
    ? snapshotIds(row.voterSnapshot).map((id) => {
      const player = db.prepare('SELECT id,username FROM players WHERE id = ?').get(id) as { id: string; username: string } | undefined;
      return { id, username: player?.username ?? id, approved: approvals.has(id) };
    })
    : eligibleVoters(db).map((player) => ({ id: player.id, username: player.username, approved: approvals.has(player.id) }));
  const requiredCount = row.status === 'published' ? snapshotIds(row.voterSnapshot).length : voters.length;
  const approvedCount = voters.filter((voter) => voter.approved).length;
  return {
    id: row.id,
    proposerId: row.proposerId,
    proposerName: row.proposerName,
    text: row.text,
    revision: row.revision,
    status: row.status,
    proposedDay: row.proposedDay,
    expiresAt: row.expiresAt,
    publishedGameMs: row.publishedGameMs,
    publishedEventId: row.publishedEventId,
    voters,
    approvedCount,
    requiredCount,
  };
}

function currentRows(db: WorldDatabase): RumorRecord[] {
  return rows(db).map((row) => record(db, row));
}

function latestOpportunityDay(db: WorldDatabase, currentDay: number): number {
  const row = db.prepare('SELECT MAX(proposed_day) AS day FROM rumors').get() as { day: number | null };
  return row.day === null ? currentDay : row.day + 3;
}

function boardFrom(db: WorldDatabase, state: WorldState): RumorBoard {
  const currentDay = dayFor(state.game_time_ms);
  const nextOpportunityDay = latestOpportunityDay(db, currentDay);
  const pending = db.prepare("SELECT id FROM rumors WHERE status = 'pending' LIMIT 1").get();
  return { currentDay, nextOpportunityDay, canPropose: !pending && currentDay >= nextOpportunityDay, rumors: currentRows(db) };
}

function pendingRow(db: WorldDatabase): RumorRow | undefined {
  return db.prepare(`SELECT r.id,r.proposer_id AS proposerId,p.username AS proposerName,r.text,r.revision,r.status,
      r.proposed_day AS proposedDay,r.expires_at AS expiresAt,r.published_game_ms AS publishedGameMs,
      r.published_event_id AS publishedEventId,r.voter_snapshot AS voterSnapshot
    FROM rumors r JOIN players p ON p.id = r.proposer_id WHERE r.status = 'pending' LIMIT 1`).get() as RumorRow | undefined;
}

function samePayload(row: RumorRow, text: string): boolean {
  return row.text === text;
}

export class RumorService {
  private readonly now: () => number;

  constructor(private readonly db: WorldDatabase, private readonly clock: CommandClock, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private expire(state: WorldState): void {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RumorError('unavailable');
    expireRumors(this.db, state, now);
  }

  board(playerId: string): RumorBoard {
    assertDb(this.db);
    assertPlayer(this.db, playerId);
    const state = this.clock.state();
    this.db.transaction(() => this.expire(state))();
    return boardFrom(this.db, this.clock.state());
  }

  propose(playerId: string, text: string): RumorBoard {
    assertDb(this.db);
    assertPlayer(this.db, playerId);
    const normalized = normalizeText(this.db, text);
    const before = this.clock.state();
    this.db.transaction(() => this.expire(before))();
    const pending = pendingRow(this.db);
    if (pending) {
      if (pending.proposerId === playerId && samePayload(pending, normalized)) return boardFrom(this.db, this.clock.state());
      throw new RumorError('conflict', pending.proposerId === playerId ? 'changed' : 'pending');
    }
    const day = dayFor(before.game_time_ms);
    if (day < latestOpportunityDay(this.db, day)) throw new RumorError('conflict', 'opportunity');
    const id = commandId('propose', playerId, day.toString(), 1, normalized);
    this.clock.commitCommand(id, (db, state) => {
      assertPlayer(db, playerId);
      this.expire(state);
      const insidePending = pendingRow(db);
      if (insidePending) {
        if (insidePending.proposerId === playerId && samePayload(insidePending, normalized)) return true;
        throw new RumorError('conflict', 'pending');
      }
      const currentDay = dayFor(state.game_time_ms);
      if (currentDay < latestOpportunityDay(db, currentDay)) throw new RumorError('conflict', 'opportunity');
      db.prepare(`INSERT INTO rumors(id,proposer_id,text,revision,status,proposed_day,expires_at,voter_snapshot)
        VALUES (?,?,?,1,'pending',?,?,?)`).run(randomUUID(), playerId, normalized, currentDay, this.now() + DEADLINE, '[]');
      return true;
    });
    return boardFrom(this.db, this.clock.state());
  }

  edit(playerId: string, id: string, revision: number, text: string): RumorBoard {
    assertDb(this.db);
    assertPlayer(this.db, playerId);
    const rumorId = assertId(id);
    const expectedRevision = assertRevision(revision);
    const normalized = normalizeText(this.db, text);
    const before = this.clock.state();
    this.db.transaction(() => this.expire(before))();
    const existing = rows(this.db).find((row) => row.id === rumorId) ?? this.db.prepare(`SELECT r.id,r.proposer_id AS proposerId,p.username AS proposerName,r.text,r.revision,r.status,
      r.proposed_day AS proposedDay,r.expires_at AS expiresAt,r.published_game_ms AS publishedGameMs,
      r.published_event_id AS publishedEventId,r.voter_snapshot AS voterSnapshot
      FROM rumors r JOIN players p ON p.id=r.proposer_id WHERE r.id=?`).get(rumorId) as RumorRow | undefined;
    if (!existing) throw new RumorError('not_found');
    if (existing.revision !== expectedRevision) throw new RumorError('conflict', 'stale');
    if (existing.status !== 'pending') throw new RumorError('conflict', 'immutable');
    if (samePayload(existing, normalized)) return boardFrom(this.db, this.clock.state());
    const command = commandId('edit', playerId, rumorId, expectedRevision, normalized);
    this.clock.commitCommand(command, (db, state) => {
      assertPlayer(db, playerId);
      this.expire(state);
      const row = db.prepare('SELECT id,text,revision,status FROM rumors WHERE id = ?').get(rumorId) as { id: string; text: string; revision: number; status: string } | undefined;
      if (!row) throw new RumorError('not_found');
      if (row.revision !== expectedRevision) throw new RumorError('conflict', 'stale');
      if (row.status !== 'pending') throw new RumorError('conflict', 'immutable');
      if (row.text === normalized) return true;
      db.prepare('DELETE FROM rumor_approvals WHERE rumor_id = ?').run(rumorId);
      db.prepare('UPDATE rumors SET text = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND status = \'pending\'').run(normalized, rumorId, expectedRevision);
      return true;
    });
    return boardFrom(this.db, this.clock.state());
  }

  approve(playerId: string, id: string, revision: number): RumorBoard {
    assertDb(this.db);
    assertPlayer(this.db, playerId);
    const rumorId = assertId(id);
    const expectedRevision = assertRevision(revision);
    const before = this.clock.state();
    this.db.transaction(() => this.expire(before))();
    const current = this.db.prepare('SELECT id,revision,status FROM rumors WHERE id = ?').get(rumorId) as { id: string; revision: number; status: string } | undefined;
    if (!current) throw new RumorError('not_found');
    if (current.revision !== expectedRevision) throw new RumorError('conflict', 'stale');
    if (current.status !== 'pending') throw new RumorError('conflict', 'immutable');
    const command = commandId('approve', playerId, rumorId, expectedRevision);
    this.clock.commitCommand(command, (db, state) => {
      assertPlayer(db, playerId);
      this.expire(state);
      const row = db.prepare('SELECT revision,status FROM rumors WHERE id = ?').get(rumorId) as { revision: number; status: string } | undefined;
      if (!row) throw new RumorError('not_found');
      if (row.revision !== expectedRevision) throw new RumorError('conflict', 'stale');
      if (row.status !== 'pending') throw new RumorError('conflict', 'immutable');
      db.prepare(`INSERT INTO rumor_approvals(rumor_id,player_id,revision) VALUES (?,?,?)
        ON CONFLICT(rumor_id,player_id) DO UPDATE SET revision = excluded.revision`).run(rumorId, playerId, expectedRevision);
      const voters = eligibleVoters(db);
      const approvals = approvalIds(db, rumorId, expectedRevision);
      if (voters.length > 0 && voters.every((voter) => approvals.has(voter.id))) {
        publishRumor(db, state, rumorId, voters.map((voter) => voter.id));
      }
      return true;
    });
    return boardFrom(this.db, this.clock.state());
  }
}
