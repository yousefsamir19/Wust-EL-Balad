import { createHash } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import type { TruthFact } from './types.js';

const DAY_MS = 86400000;
// A ledger entry recording speech/belief is not proof of the action it describes.
const ASSERTION_TYPE = /(?:spoke|spoken|speak|speech|utterance|conversation|statement|testimony|hearsay|rumou?r|claim|disclos|secret|assert|suggest|intervention|propos|allegation|belief|thought|intent|plan|question|request|(?:^|_)(?:said|told|talked|lied|lie|lying)(?:_|$))/i;
interface EventRow {
  id: number; actor_id: string | null; type: string; target: string | null;
  amount: number | null; game_time_ms: number; details: string;
}
interface NamedRow { id: string; name: string }

function known(value: unknown, names: Map<string, string>): string | null {
  if (typeof value !== 'string') return null;
  if (names.has(value)) return value;
  const id = value.replace(/^(?:citizen|business|building):/, '');
  if (names.has(id)) return id;
  const matches = [...names].filter(([, name]) => name === value);
  return matches.length === 1 ? matches[0][0] : null;
}

/** Caller owns the day-closing transaction; an existing snapshot is never refreshed. */
export function captureInvestigationTruth(db: WorldDatabase, day: number, closedGameMs: number): void {
  if (!Number.isSafeInteger(day) || day < 1 || !Number.isSafeInteger(day * DAY_MS)) throw new Error('Invalid investigation day');
  if (db.prepare('SELECT day FROM investigation_truth WHERE day=?').get(day)) return;
  if (!Number.isSafeInteger(closedGameMs) || closedGameMs < 0) throw new Error('Invalid investigation close time');
  const citizens = new Map((db.prepare('SELECT id,name FROM citizens ORDER BY id').all() as NamedRow[]).map(row => [row.id, row.name]));
  const buildings = new Map((db.prepare('SELECT id,name FROM buildings ORDER BY id').all() as NamedRow[]).map(row => [row.id, row.name]));
  const targets = new Map([...buildings, ...citizens]);
  const rows = db.prepare(`SELECT id,actor_id,type,target,amount,game_time_ms,details FROM events
    WHERE importance>=50 AND game_time_ms>=? AND game_time_ms<? ORDER BY id`)
    .all((day - 1) * DAY_MS, day * DAY_MS) as EventRow[];
  const facts: TruthFact[] = [];
  for (const row of rows) {
    if (ASSERTION_TYPE.test(row.type)) continue;
    let details: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.details);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
    } catch { /* Malformed details cannot introduce a historical location. */ }
    const actorId = known(row.actor_id, citizens);
    const targetId = known(row.target, targets);
    // Never use the citizen's current position/home/workplace to infer yesterday's location.
    const locationId = known(row.target, buildings) ?? known(details.location, buildings) ?? known(details.building_id, buildings);
    facts.push({
      eventId: row.id, actorId, actorName: actorId === null ? '' : citizens.get(actorId) ?? '',
      action: row.type, targetId, targetName: targetId === null ? '' : targets.get(targetId) ?? '',
      locationId, locationName: locationId === null ? '' : buildings.get(locationId) ?? '',
      amount: Number.isSafeInteger(row.amount) ? row.amount : null, gameTimeMs: row.game_time_ms,
    });
  }
  const serialized = JSON.stringify(facts);
  const hash = createHash('sha256').update(serialized).digest('hex');
  db.prepare('INSERT INTO investigation_truth(day,closed_game_ms,facts,snapshot_hash) VALUES(?,?,?,?) ON CONFLICT(day) DO NOTHING')
    .run(day, closedGameMs, serialized, hash);
}

/** Read frozen slots only; an absent snapshot must not fall back to live world state. */
export function getTruth(db: WorldDatabase, day: number): TruthFact[] {
  const row = db.prepare('SELECT facts FROM investigation_truth WHERE day=?').get(day) as { facts: string } | undefined;
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.facts);
  if (!Array.isArray(parsed)) throw new Error('Invalid investigation truth snapshot');
  return parsed as TruthFact[];
}
