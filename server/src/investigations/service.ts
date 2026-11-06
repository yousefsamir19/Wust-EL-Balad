import { createHash } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import type { AiScheduler } from '../ai/scheduler.js';
import { SimulationClock } from '../simulation/clock.js';
import { captureInvestigationTruth, getTruth } from './truth.js';
import { localScore, scoreInvestigation } from './scoring.js';
import type { ScoreEvaluation, ScoreMatch, TruthFact } from './types.js';
import type { InvestigationDay, InvestigationResult, InvestigationSubmission, InvestigationView } from '../../../shared/investigations.js';

const MAX_ANSWER_CHARS = 4000;
const MAX_AWARD = 12;
const MAX_QUALITY = 1;

type StoredAuditMatch = { eventId: number; quote: string; quality: number };
type StoredResult = InvestigationResult & { audit?: { matches: StoredAuditMatch[] } };

type InvestigationRow = {
  id: string;
  playerId: string;
  day: number;
  answers: string;
  status: 'pending' | 'submitted' | 'skipped';
  result: string | null;
  createdAt: string | null;
  completedGameMs: number | null;
};

type ClosedDay = { day: number; closedGameMs: number };

export class InvestigationError extends Error {
  constructor(public readonly code: 'invalid' | 'not_found' | 'unauthorized' | 'conflict' | 'stopped' | 'unavailable', message: string = code) {
    super(message);
    this.name = 'InvestigationError';
  }
}

function commandId(kind: string, playerId: string, day: number): string {
  const id = `investigation-${kind}:${playerId}:${day}`;
  if (!playerId || id.length > 128) throw new InvestigationError('invalid');
  return id;
}

function truthCommandId(day: number): string {
  return `investigation-truth:${day}`;
}

function normalizeAnswer(answer: unknown): string {
  if (typeof answer !== 'string') throw new InvestigationError('invalid');
  const normalized = answer.trim();
  if (!normalized || normalized.length > MAX_ANSWER_CHARS || Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && !['\t', '\n', '\r'].includes(character);
  })) throw new InvestigationError('invalid');
  return normalized;
}

function parseAnswers(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).answer === 'string') {
      return (parsed as Record<string, string>).answer;
    }
  } catch { /* A malformed legacy row is treated as an empty answer. */ }
  return '';
}

function parseStoredResult(value: string | null): StoredResult | null {
  if (!value) return null;
  try {
    const result = JSON.parse(value) as Partial<StoredResult>;
    if (!result || typeof result !== 'object') return null;
    if (typeof result.correctEvents !== 'number' || typeof result.totalEvents !== 'number' ||
      typeof result.accuracy !== 'number' || typeof result.influenceAwarded !== 'number' ||
      (result.source !== 'local' && result.source !== 'network')) return null;
    return {
      correctEvents: result.correctEvents,
      totalEvents: result.totalEvents,
      accuracy: result.accuracy,
      influenceAwarded: result.influenceAwarded,
      source: result.source,
      ...(result.audit ? { audit: result.audit } : {}),
    };
  } catch {
    return null;
  }
}

function publicResult(result: StoredResult | null): InvestigationResult | null {
  if (!result) return null;
  return {
    correctEvents: result.correctEvents,
    totalEvents: result.totalEvents,
    accuracy: result.accuracy,
    influenceAwarded: result.influenceAwarded,
    source: result.source,
  };
}

function rowFrom(db: WorldDatabase, playerId: string, day: number): InvestigationRow | undefined {
  return db.prepare(`SELECT id,player_id AS playerId,day,answers,status,result,created_at AS createdAt,
      completed_game_ms AS completedGameMs FROM investigations WHERE player_id=? AND day=?`).get(playerId, day) as InvestigationRow | undefined;
}

function rowById(db: WorldDatabase, id: string): InvestigationRow | undefined {
  return db.prepare(`SELECT id,player_id AS playerId,day,answers,status,result,created_at AS createdAt,
      completed_game_ms AS completedGameMs FROM investigations WHERE id=?`).get(id) as InvestigationRow | undefined;
}

function closedDay(db: WorldDatabase, day: number): ClosedDay | undefined {
  return db.prepare('SELECT day,closed_game_ms AS closedGameMs FROM closed_days WHERE day=?').get(day) as ClosedDay | undefined;
}

function isAuthorized(db: WorldDatabase, playerId: string): boolean {
  try {
    const player = db.prepare('SELECT id,banned FROM players WHERE id=?').get(playerId) as { id: string; banned: number } | undefined;
    return !!player && player.banned === 0;
  } catch {
    return false;
  }
}

function assertAuthorized(db: WorldDatabase, playerId: string): void {
  if (!isAuthorized(db, playerId)) throw new InvestigationError('unauthorized');
}

function assertDay(day: number): void {
  if (!Number.isSafeInteger(day) || day < 1) throw new InvestigationError('invalid');
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeLocal(answer: string, facts: TruthFact[]): ScoreEvaluation {
  try {
    const value = localScore(answer, facts) as unknown;
    if (Array.isArray(value)) return { matches: value as ScoreMatch[], source: 'local' };
    if (value && typeof value === 'object' && Array.isArray((value as { matches?: unknown }).matches)) {
      return { matches: (value as { matches: ScoreMatch[] }).matches, source: 'local' };
    }
    return { matches: [], source: 'local' };
  } catch {
    return { matches: [], source: 'local' };
  }
}

function scoreResult(evaluation: ScoreEvaluation, facts: TruthFact[]): StoredResult {
  const supported = new Map<number, TruthFact>();
  for (const fact of facts) {
    if (Number.isSafeInteger(fact.eventId) && !supported.has(fact.eventId)) supported.set(fact.eventId, fact);
  }
  const seen = new Set<number>();
  const matches: StoredAuditMatch[] = [];
  for (const candidate of Array.isArray(evaluation.matches) ? evaluation.matches : []) {
    if (!candidate || !Number.isSafeInteger(candidate.eventId) || seen.has(candidate.eventId) || !supported.has(candidate.eventId)) continue;
    const quality = Number(candidate.quality);
    if (!Number.isFinite(quality) || quality <= 0) continue;
    seen.add(candidate.eventId);
    matches.push({
      eventId: candidate.eventId,
      quote: typeof candidate.quote === 'string' ? candidate.quote.slice(0, 2000) : '',
      quality: Math.min(MAX_QUALITY, quality),
    });
  }
  const totalEvents = supported.size;
  const influenceAwarded = Math.min(MAX_AWARD, Math.max(0, Math.floor(matches.reduce((sum, match) => sum + match.quality * 2, 0))));
  return {
    correctEvents: matches.length,
    totalEvents,
    accuracy: totalEvents ? matches.length / totalEvents : 0,
    influenceAwarded,
    source: evaluation.source === 'network' ? 'network' : 'local',
    audit: { matches },
  };
}

export class InvestigationService {
  private stopped = false;
  private readonly inFlight = new Map<string, { answer: string; promise: Promise<InvestigationView> }>();

  constructor(private readonly db: WorldDatabase, private readonly clock: SimulationClock, private readonly ai?: AiScheduler) {
    if (!this.open()) {
      this.stopped = true;
      return;
    }
    try {
      this.backfillTruth();
      void this.recoverPending().catch(() => undefined);
    } catch {
      this.stopped = true;
    }
  }

  private open(): boolean {
    try { return !this.stopped && this.db.open; } catch { return false; }
  }

  private ensureOpen(): void {
    if (!this.open()) throw new InvestigationError('stopped');
  }

  private backfillTruth(): void {
    const missing = this.db.prepare(`SELECT c.day,c.closed_game_ms AS closedGameMs FROM closed_days c
      LEFT JOIN investigation_truth t ON t.day=c.day WHERE t.day IS NULL ORDER BY c.day`).all() as ClosedDay[];
    for (const day of missing) {
      this.clock.commitCommand(truthCommandId(day.day), (db) => {
        if (db.prepare('SELECT day FROM investigation_truth WHERE day=?').get(day.day)) return true;
        const captured = captureInvestigationTruth(db, day.day, day.closedGameMs) as unknown;
        // The truth helper normally persists its own immutable row. Keep a compatibility
        // path for helpers that return facts instead, without ever refreshing an existing row.
        if (!db.prepare('SELECT day FROM investigation_truth WHERE day=?').get(day.day)) {
          const facts = Array.isArray(captured) ? captured : getTruth(db, day.day);
          db.prepare(`INSERT INTO investigation_truth(day,closed_game_ms,facts,snapshot_hash)
            VALUES(?,?,?,?)`).run(day.day, day.closedGameMs, JSON.stringify(facts), stableHash(facts));
        }
        return true;
      });
    }
  }

  private async recoverPending(): Promise<void> {
    if (!this.open()) return;
    const pending = this.db.prepare("SELECT player_id AS playerId,day,answers FROM investigations WHERE status='pending' ORDER BY created_at,id").all() as Array<{ playerId: string; day: number; answers: string }>;
    for (const row of pending) {
      if (!this.open()) return;
      const answer = parseAnswers(row.answers);
      if (!answer) continue;
      try { await this.submit(row.playerId, row.day, answer); } catch { /* A later retry can resume an unresolved pending row. */ }
    }
  }

  private ensureClosedDay(day: number): ClosedDay {
    assertDay(day);
    const closed = closedDay(this.db, day);
    if (!closed) throw new InvestigationError('not_found');
    return closed;
  }

  private async evaluate(answer: string, facts: TruthFact[]): Promise<StoredResult> {
    let evaluation: ScoreEvaluation;
    try {
      evaluation = await scoreInvestigation(answer, facts, this.ai);
      if (!evaluation || !Array.isArray(evaluation.matches)) throw new Error('invalid scoring result');
    } catch {
      evaluation = safeLocal(answer, facts);
    }
    return scoreResult(evaluation, facts);
  }

  private async submitPending(playerId: string, day: number, answer: string): Promise<InvestigationView> {
    this.ensureOpen();
    assertAuthorized(this.db, playerId);
    this.ensureClosedDay(day);
    const id = commandId('submission', playerId, day);
    const createdAt = new Date().toISOString();

    this.clock.commitCommand(id, (db, state) => {
      assertAuthorized(db, playerId);
      const existing = rowById(db, id) ?? rowFrom(db, playerId, day);
      if (existing) {
        if (parseAnswers(existing.answers) !== answer) throw new InvestigationError('conflict', 'changed');
        if (existing.status === 'skipped') throw new InvestigationError('conflict', 'alreadyfinal');
        return true;
      }
      if (!closedDay(db, day)) throw new InvestigationError('not_found');
      db.prepare(`INSERT INTO investigations(id,player_id,day,answers,status,result,created_at,completed_game_ms)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, playerId, day, JSON.stringify({ answer }), 'pending', null, createdAt, null);
      return state.game_time_ms;
    });

    this.ensureOpen();
    assertAuthorized(this.db, playerId);
    let facts: TruthFact[];
    try { facts = getTruth(this.db, day); } catch { throw new InvestigationError('unavailable'); }
    if (!Array.isArray(facts)) throw new InvestigationError('unavailable');
    const result = await this.evaluate(answer, facts);
    this.ensureOpen();
    assertAuthorized(this.db, playerId);

    const finalizeId = commandId('finalize', playerId, day);
    this.clock.commitCommand(finalizeId, (db, state) => {
      const row = rowById(db, id) ?? rowFrom(db, playerId, day);
      if (!row) throw new InvestigationError('not_found');
      if (parseAnswers(row.answers) !== answer) throw new InvestigationError('conflict', 'changed');
      if (row.status === 'submitted' || row.status === 'skipped') return true;
      if (!isAuthorized(db, playerId)) {
        const zero: StoredResult = { correctEvents: 0, totalEvents: result.totalEvents, accuracy: 0, influenceAwarded: 0, source: 'local', audit: { matches: [] } };
        db.prepare(`UPDATE investigations SET status='skipped',result=?,completed_game_ms=? WHERE id=?`)
          .run(JSON.stringify(zero), state.game_time_ms, row.id);
        return true;
      }
      const award = Math.min(MAX_AWARD, Math.max(0, Math.trunc(result.influenceAwarded)));
      const ledgerId = `investigation-award:${playerId}:${day}`;
      const ledger = db.prepare('INSERT OR IGNORE INTO influence_ledger(id,player_id,amount,reason,game_time_ms) VALUES(?,?,?,?,?)')
        .run(ledgerId, playerId, award, `investigation:${day}`, state.game_time_ms);
      if (ledger.changes > 0 && award > 0) db.prepare('UPDATE players SET influence=influence+? WHERE id=? AND banned=0').run(award, playerId);
      db.prepare(`UPDATE investigations SET status='submitted',result=?,completed_game_ms=? WHERE id=?`)
        .run(JSON.stringify({ ...result, influenceAwarded: award }), state.game_time_ms, row.id);
      return true;
    });

    if (!isAuthorized(this.db, playerId)) throw new InvestigationError('unauthorized');
    return this.view(playerId, day);
  }

  private startSubmit(playerId: string, day: number, answer: string): Promise<InvestigationView> {
    const key = `${playerId}:${day}`;
    const running = this.inFlight.get(key);
    if (running) {
      if (running.answer !== answer) throw new InvestigationError('conflict', 'changed');
      return running.promise;
    }
    const promise = this.submitPending(playerId, day, answer).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { answer, promise });
    return promise;
  }

  private validatePlayer(playerId: string): void {
    this.ensureOpen();
    if (typeof playerId !== 'string' || !playerId) throw new InvestigationError('invalid');
    assertAuthorized(this.db, playerId);
  }

  list(playerId: string): InvestigationDay[] {
    this.validatePlayer(playerId);
    const days = this.db.prepare('SELECT day FROM closed_days ORDER BY day DESC').all() as Array<{ day: number }>;
    return days.map(({ day }) => {
      const row = rowFrom(this.db, playerId, day);
      return { day, status: row?.status ?? 'open' };
    });
  }

  view(playerId: string, day: number): InvestigationView {
    this.validatePlayer(playerId);
    this.ensureClosedDay(day);
    const own = rowFrom(this.db, playerId, day);
    const ownStatus = own?.status ?? 'open';
    const ownSubmission: InvestigationSubmission | null = own ? {
      id: own.id,
      day: own.day,
      answer: parseAnswers(own.answers),
      status: own.status,
      result: publicResult(parseStoredResult(own.result)),
    } : null;
    const others: InvestigationView['others'] = [];
    if (ownStatus === 'submitted' || ownStatus === 'skipped') {
      const rows = this.db.prepare(`SELECT i.id,i.player_id AS playerId,p.username,i.day,i.answers,i.status,i.result
        FROM investigations i JOIN players p ON p.id=i.player_id
        WHERE i.day=? AND i.player_id<>? AND p.banned=0 AND i.status IN ('submitted','skipped') ORDER BY i.id`).all(day, playerId) as Array<InvestigationRow & { username: string }>;
      for (const row of rows) {
        others.push({
          playerId: row.playerId,
          username: row.username,
          answer: parseAnswers(row.answers),
          result: publicResult(parseStoredResult(row.result)),
        });
      }
    }
    return { day, status: ownStatus, own: ownSubmission, others };
  }

  async submit(playerId: string, day: number, answer: string): Promise<InvestigationView> {
    this.validatePlayer(playerId);
    const normalized = normalizeAnswer(answer);
    this.ensureClosedDay(day);
    const existing = rowFrom(this.db, playerId, day);
    if (existing) {
      if (parseAnswers(existing.answers) !== normalized) throw new InvestigationError('conflict', 'changed');
      if (existing.status === 'submitted' || existing.status === 'skipped') {
        if (existing.status === 'skipped') throw new InvestigationError('conflict', 'alreadyfinal');
        return this.view(playerId, day);
      }
    }
    return this.startSubmit(playerId, day, normalized);
  }

  skip(playerId: string, day: number): InvestigationView {
    this.validatePlayer(playerId);
    this.ensureClosedDay(day);
    const id = commandId('skip', playerId, day);
    return this.clock.commitCommand(id, (db, state) => {
      assertAuthorized(db, playerId);
      const existing = rowFrom(db, playerId, day);
      if (existing) {
        if (existing.status === 'submitted') throw new InvestigationError('conflict', 'alreadyfinal');
        if (existing.status === 'pending') throw new InvestigationError('conflict', 'alreadyfinal');
        return true;
      }
      const result: StoredResult = { correctEvents: 0, totalEvents: 0, accuracy: 0, influenceAwarded: 0, source: 'local', audit: { matches: [] } };
      db.prepare(`INSERT INTO investigations(id,player_id,day,answers,status,result,created_at,completed_game_ms)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, playerId, day, JSON.stringify({ answer: '' }), 'skipped', JSON.stringify(result), new Date().toISOString(), state.game_time_ms);
      return true;
    }), this.view(playerId, day);
  }

  stop(): void {
    this.stopped = true;
    // Deliberately do not touch the database; late scoring callbacks cannot commit after shutdown.
  }
}
