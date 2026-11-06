import type { WorldDatabase } from '../db/index.js';
import type { Provenance, SocialEvent } from './types.js';

const MAX_TEXT = 280;
const MEMORY_CAPS: Readonly<Record<string, number>> = {
  short_term: 24,
  episodic: 32,
  relationship: 24,
  belief: 32,
  long_term: 16,
};
const KNOWLEDGE_CAP = 48;
const VALID_PROVENANCE: ReadonlySet<Provenance> = new Set(['observation', 'told', 'belief', 'rumor', 'summary']);

type MemoryRow = {
  id: number;
  content: string;
  game_time_ms: number;
  importance: number;
  confidence: number;
  provenance: Provenance;
  source_event_id: number | null;
};

type SourceRow = {
  memory_id: number;
  event_id: number;
  type: string;
  visibility: 'public' | 'private';
  game_time_ms: number;
};

type SummaryGroup = {
  visibility: 'public' | 'private';
  provenance: Provenance;
  type: string;
  eventIds: number[];
  count: number;
  latestGameTimeMs: number;
  importance: number;
  confidence: number;
};

function requireTransaction(db: WorldDatabase): void {
  if (!db.inTransaction) throw new Error('Social memory operations require an active transaction.');
}

function clipped(value: string): string {
  return value.trim().slice(0, MAX_TEXT);
}

function boundedConfidence(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Memory confidence must be finite.');
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedImportance(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Event importance must be finite.');
  return Math.max(0, Math.min(100, Math.round(value)));
}

function authorize(db: WorldDatabase, citizenId: string, eventId: number): void {
  const allowed = db.prepare(
    'SELECT 1 AS ok FROM observed_events WHERE citizen_id = ? AND event_id = ?',
  ).get(citizenId, eventId) as { ok: number } | undefined;
  if (!allowed) throw new Error('Citizen is not authorized to store this event.');
}

function memoryVisibility(eventVisibility: string): 'public' | 'private' {
  return eventVisibility === 'public' ? 'public' : 'private';
}

function saveMemory(
  db: WorldDatabase,
  citizenId: string,
  layer: string,
  content: string,
  gameTimeMs: number,
  importance: number,
  sourceEventId: number | null,
  otherId: string | null,
  visibility: 'public' | 'private',
  provenance: Provenance,
  confidence: number,
): number {
  const existing = sourceEventId === null
    ? db.prepare(`SELECT id FROM memories
        WHERE citizen_id = ? AND layer = ? AND content = ? AND source_event_id IS NULL AND other_id IS ?
        ORDER BY id LIMIT 1`).get(citizenId, layer, content, otherId) as { id: number } | undefined
    : db.prepare(`SELECT id FROM memories
        WHERE citizen_id = ? AND layer = ? AND content = ? AND source_event_id = ? AND other_id IS ?
        ORDER BY id LIMIT 1`).get(citizenId, layer, content, sourceEventId, otherId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`UPDATE memories SET game_time_ms = ?, importance = ?, visibility = ?, provenance = ?, confidence = ?
      WHERE id = ?`).run(gameTimeMs, importance, visibility, provenance, confidence, existing.id);
    if (sourceEventId !== null) {
      db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, event_id) VALUES (?, ?)').run(existing.id, sourceEventId);
    }
    return existing.id;
  }

  const result = db.prepare(`INSERT INTO memories
    (citizen_id, layer, content, game_time_ms, importance, source_event_id, other_id, visibility, provenance, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    citizenId,
    layer,
    content,
    gameTimeMs,
    importance,
    sourceEventId,
    otherId,
    visibility,
    provenance,
    confidence,
  );
  const memoryId = Number(result.lastInsertRowid);
  if (sourceEventId !== null) {
    db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, event_id) VALUES (?, ?)').run(memoryId, sourceEventId);
  }
  return memoryId;
}

function saveKnowledge(
  db: WorldDatabase,
  citizenId: string,
  kind: 'observation' | 'told' | 'belief' | 'rumor',
  claim: string,
  confidence: number,
  sourceCitizenId: string | null,
  sourceEventId: number,
  gameTimeMs: number,
): void {
  const existing = db.prepare(`SELECT id FROM knowledge
    WHERE citizen_id = ? AND kind = ? AND claim = ? ORDER BY id LIMIT 1`).get(citizenId, kind, claim) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE knowledge SET confidence = ?, source_citizen_id = ?, source_event_id = ?, game_time_ms = ?
      WHERE id = ?`).run(confidence, sourceCitizenId, sourceEventId, gameTimeMs, existing.id);
    return;
  }
  db.prepare(`INSERT INTO knowledge
    (citizen_id, kind, claim, confidence, source_citizen_id, source_event_id, game_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    citizenId,
    kind,
    claim,
    confidence,
    sourceCitizenId,
    sourceEventId,
    gameTimeMs,
  );
}

function knowledgeKind(mode: Provenance): 'observation' | 'told' | 'belief' | 'rumor' | null {
  return mode === 'summary' ? null : mode;
}

function store(
  db: WorldDatabase,
  event: SocialEvent,
  citizenId: string,
  mode: Provenance,
  content: string,
  otherId: string | null,
  confidence: number,
): void {
  requireTransaction(db);
  if (!VALID_PROVENANCE.has(mode)) throw new Error(`Unsupported provenance: ${mode}`);
  authorize(db, citizenId, event.id);
  const text = clipped(content);
  if (!text) throw new Error('Memory content cannot be empty.');
  const importance = boundedImportance(event.importance);
  const certainty = boundedConfidence(confidence);
  const visibility = memoryVisibility(event.visibility);
  const layers = ['short_term'];
  if (importance >= 50) layers.push('episodic');
  if (otherId !== null) layers.push('relationship');
  if (mode === 'told' || mode === 'rumor' || mode === 'belief') layers.push('belief');
  if (importance >= 80) layers.push('long_term');
  for (const layer of layers) {
    saveMemory(db, citizenId, layer, text, event.game_time_ms, importance, event.id, otherId, visibility, mode, certainty);
  }
  const kind = knowledgeKind(mode);
  if (kind !== null) {
    saveKnowledge(db, citizenId, kind, text, certainty, event.actor_id, event.id, event.game_time_ms);
  }
}

export function remember(
  db: WorldDatabase,
  event: SocialEvent,
  citizenId: string,
  mode: Provenance,
  content: string,
  otherId: string | null,
  confidence = 100,
): void {
  store(db, event, citizenId, mode, content, otherId, confidence);
}

export function believe(
  db: WorldDatabase,
  citizenId: string,
  claim: string,
  confidence: number,
  sourceEventId: number,
  otherId: string | null,
): void {
  requireTransaction(db);
  authorize(db, citizenId, sourceEventId);
  const event = db.prepare(`SELECT id, game_time_ms, type, actor_id, target, amount, importance, visibility, details, world_version
    FROM events WHERE id = ?`).get(sourceEventId) as SocialEvent | undefined;
  if (!event) throw new Error('Belief source event does not exist.');
  store(db, event, citizenId, 'belief', claim, otherId, confidence);
}

function compactShortTerm(db: WorldDatabase, citizenId: string, gameTimeMs: number): void {
  const rows = db.prepare(`SELECT id, content, game_time_ms, importance, confidence, provenance, source_event_id
    FROM memories WHERE citizen_id = ? AND layer = 'short_term'
    ORDER BY game_time_ms DESC, id DESC`).all(citizenId) as MemoryRow[];
  const overflow = rows.slice(MEMORY_CAPS.short_term);
  if (overflow.length === 0) return;

  const placeholders = overflow.map(() => '?').join(',');
  const sources = db.prepare(`SELECT ms.memory_id, ms.event_id, e.type, e.visibility, e.game_time_ms
    FROM memory_sources ms
    JOIN events e ON e.id = ms.event_id
    JOIN observed_events oe ON oe.event_id = ms.event_id AND oe.citizen_id = ?
    WHERE ms.memory_id IN (${placeholders})
    ORDER BY e.game_time_ms ASC, e.id ASC`).all(citizenId, ...overflow.map((row) => row.id)) as SourceRow[];

  const groups = new Map<string, SummaryGroup>();
  for (const source of sources) {
    const sourceMemory = overflow.find((row) => row.id === source.memory_id);
    if (!sourceMemory) continue;
    const key = `${source.visibility}\u0000${sourceMemory.provenance}\u0000${source.type}`;
    const current = groups.get(key) ?? {
      visibility: source.visibility,
      provenance: sourceMemory.provenance,
      type: source.type,
      eventIds: [],
      count: 0,
      latestGameTimeMs: source.game_time_ms,
      importance: sourceMemory.importance,
      confidence: sourceMemory.confidence,
    };
    if (!current.eventIds.includes(source.event_id)) {
      current.eventIds.push(source.event_id);
      current.count += 1;
    }
    current.latestGameTimeMs = Math.max(current.latestGameTimeMs, source.game_time_ms);
    current.importance = Math.max(current.importance, sourceMemory.importance);
    current.confidence = Math.min(current.confidence, sourceMemory.confidence);
    groups.set(key, current);
  }

  const summaryGroups = [...groups.values()].sort((a, b) =>
    a.visibility.localeCompare(b.visibility) || a.provenance.localeCompare(b.provenance) || a.type.localeCompare(b.type));
  for (const group of summaryGroups) {
    const eventIds = group.eventIds.slice(0, 12);
    const content = clipped(`Event summary: visibility=${group.visibility}; provenance=${group.provenance}; type=${group.type}; count=${group.count}.`);
    const memoryId = saveMemory(
      db,
      citizenId,
      'long_term',
      content,
      gameTimeMs,
      group.importance,
      eventIds[0] ?? null,
      null,
      group.visibility,
      'summary',
      group.confidence,
    );
    for (const eventId of eventIds) {
      db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id, event_id) VALUES (?, ?)').run(memoryId, eventId);
    }
  }

  db.prepare(`DELETE FROM memories WHERE citizen_id = ? AND layer = 'short_term' AND id IN (${placeholders})`)
    .run(citizenId, ...overflow.map((row) => row.id));
}

function capMemories(db: WorldDatabase, citizenId: string, layer: string, cap: number, order: string): void {
  const ids = db.prepare(`SELECT id FROM memories WHERE citizen_id = ? AND layer = ? ORDER BY ${order}`)
    .all(citizenId, layer) as Array<{ id: number }>;
  const excess = ids.slice(cap);
  if (excess.length === 0) return;
  const placeholders = excess.map(() => '?').join(',');
  db.prepare(`DELETE FROM memories WHERE citizen_id = ? AND id IN (${placeholders})`)
    .run(citizenId, ...excess.map((row) => row.id));
}

function capKnowledge(db: WorldDatabase, citizenId: string): void {
  const ids = db.prepare(`SELECT id FROM knowledge WHERE citizen_id = ?
    ORDER BY confidence DESC, game_time_ms DESC, id DESC`).all(citizenId) as Array<{ id: number }>;
  const excess = ids.slice(KNOWLEDGE_CAP);
  if (excess.length === 0) return;
  const placeholders = excess.map(() => '?').join(',');
  db.prepare(`DELETE FROM knowledge WHERE citizen_id = ? AND id IN (${placeholders})`)
    .run(citizenId, ...excess.map((row) => row.id));
}

export function compactMemories(db: WorldDatabase, citizenId: string, gameTimeMs: number): void {
  requireTransaction(db);
  if (!Number.isFinite(gameTimeMs)) throw new Error('Compaction time must be finite.');
  compactShortTerm(db, citizenId, gameTimeMs);
  capMemories(db, citizenId, 'short_term', MEMORY_CAPS.short_term, 'game_time_ms DESC, id DESC');
  capMemories(db, citizenId, 'episodic', MEMORY_CAPS.episodic, 'importance DESC, game_time_ms DESC, id DESC');
  capMemories(db, citizenId, 'relationship', MEMORY_CAPS.relationship, 'importance DESC, game_time_ms DESC, id DESC');
  capMemories(db, citizenId, 'belief', MEMORY_CAPS.belief, 'importance DESC, game_time_ms DESC, id DESC');
  capMemories(db, citizenId, 'long_term', MEMORY_CAPS.long_term, 'importance DESC, game_time_ms DESC, id DESC');
  capKnowledge(db, citizenId);
}
