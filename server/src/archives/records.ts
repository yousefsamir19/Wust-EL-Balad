import { createHash } from 'node:crypto';
import type { ArchiveEvent, NewsLabel } from '../../../shared/archives.js';
import type { WorldDatabase } from '../db/index.js';
import { captureInvestigationTruth } from '../investigations/truth.js';

const GAME_DAY_MS = 86400000;

type EventRow = {
  id: number;
  gameTimeMs: number;
  type: string;
  actorId: string | null;
  target: string | null;
  amount: number | null;
  importance: number;
  details: string;
  causeId: number | null;
  causeDay: number | null;
};

type PersonRow = { id: string; name: string };
type BuildingRow = { id: string; name: string };

function labelFor(type: string): NewsLabel {
  const normalized = type.toLowerCase();
  if (normalized.includes('rumor')) return 'rumor';
  if (type === 'citizen_spoke' || /(claim|disclos|secret)/i.test(type)) return 'unverified';
  return 'confirmed';
}

function safeDetails(value: string): { text?: string; activity?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const result: { text?: string; activity?: string } = {};
    if (typeof record.text === 'string') result.text = record.text.slice(0, 1000);
    if (typeof record.activity === 'string') result.activity = record.activity.slice(0, 160);
    return result;
  } catch {
    return {};
  }
}

function names(db: WorldDatabase): { citizens: Map<string, string>; buildings: Map<string, string> } {
  const citizens = new Map((db.prepare('SELECT id,name FROM citizens ORDER BY id').all() as PersonRow[]).map((row) => [row.id, row.name]));
  const buildings = new Map((db.prepare('SELECT id,name FROM buildings ORDER BY id').all() as BuildingRow[]).map((row) => [row.id, row.name]));
  return { citizens, buildings };
}

function projectRows(db: WorldDatabase, day: number): ArchiveEvent[] {
  if (!Number.isSafeInteger(day) || day < 1) throw new Error('Archive day must be a positive integer');
  const start = (day - 1) * GAME_DAY_MS;
  const end = day * GAME_DAY_MS;
  const rows = db.prepare(`SELECT e.id,e.game_time_ms AS gameTimeMs,e.type,e.actor_id AS actorId,e.target,e.amount,e.importance,e.details,
      CASE WHEN cause.id IS NULL THEN NULL ELSE e.cause_id END AS causeId,
      CASE WHEN cause.id IS NULL THEN NULL ELSE CAST(cause.game_time_ms / ${GAME_DAY_MS} AS INTEGER) + 1 END AS causeDay
    FROM events e
    LEFT JOIN events cause ON cause.id=e.cause_id AND cause.visibility='public'
    WHERE e.visibility='public' AND e.game_time_ms>=? AND e.game_time_ms<?
    ORDER BY e.id`).all(start, end) as EventRow[];
  const { citizens, buildings } = names(db);
  const result: ArchiveEvent[] = [];
  for (const row of rows) {
    const details = safeDetails(row.details);
    const actorName = row.actorId === null ? '' : citizens.get(row.actorId) ?? buildings.get(row.actorId) ?? '';
    const targetName = row.target === null ? '' : citizens.get(row.target) ?? buildings.get(row.target) ?? '';
    const event: ArchiveEvent = {
      id: row.id,
      gameTimeMs: row.gameTimeMs,
      type: row.type,
      actorId: row.actorId,
      target: row.target,
      amount: row.amount,
      importance: row.importance,
      actorName,
      targetName,
      causeId: row.causeId,
      causeDay: row.causeDay,
      label: labelFor(row.type),
    };
    if (details.text !== undefined) event.text = details.text;
    if (details.activity !== undefined) event.activity = details.activity;
    result.push(event);
  }
  return result;
}

export function captureDaySources(db: WorldDatabase, day: number, closedGameMs: number): void {
  captureInvestigationTruth(db,day,closedGameMs);
  const existing = db.prepare('SELECT day FROM chronicle_sources WHERE day=?').get(day) as { day: number } | undefined;
  if (existing) return;
  const events = projectRows(db, day);
  const serialized = JSON.stringify(events);
  const snapshotHash = createHash('sha256').update(serialized).digest('hex');
  db.prepare('INSERT OR IGNORE INTO chronicle_sources(day,closed_game_ms,snapshot_hash,events) VALUES(?,?,?,?)')
    .run(day, closedGameMs, snapshotHash, serialized);
}

export function readDaySources(db: WorldDatabase, day: number): { closedGameMs: number; snapshotHash: string; events: ArchiveEvent[] } | undefined {
  const row = db.prepare('SELECT closed_game_ms AS closedGameMs,snapshot_hash AS snapshotHash,events FROM chronicle_sources WHERE day=?').get(day) as { closedGameMs: number; snapshotHash: string; events: string } | undefined;
  if (!row) return undefined;
  const parsed: unknown = JSON.parse(row.events);
  if (!Array.isArray(parsed)) throw new Error('Invalid chronicle source snapshot');
  return { closedGameMs: row.closedGameMs, snapshotHash: row.snapshotHash, events: parsed as ArchiveEvent[] };
}

export function publicDayEvents(db: WorldDatabase, day: number): ArchiveEvent[] {
  return readDaySources(db, day)?.events ?? projectRows(db, day);
}
