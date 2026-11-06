import type { WorldDatabase } from '../db/index.js';
import type { PublicMemory, PublicRelationship, PublicSocial, Provenance } from './types.js';

type JsonValue = unknown;

type CitizenRow = {
  id: string;
  name: string;
  job: string;
  personality: string;
  goals: string;
  needs: string;
  mood: string;
  reputation: number;
  money: number;
};

type RelationshipRow = {
  otherId: string;
  name: string;
  trust: number;
  affection: number;
  respect: number;
  fear: number;
  debt: number;
  grudge: number;
  suspicion: number;
  dependence: number;
  secretsKnown: string;
};

type MemoryRow = {
  id: number;
  layer: string;
  content: string;
  gameTimeMs: number;
  provenance: Provenance;
  confidence: number;
  sourceEventId: number | null;
};

function clip(value: string): string {
  return value.trim().slice(0, 280);
}

function parseJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function parseIdList(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function publicMemory(row: MemoryRow): PublicMemory {
  return {
    id: row.id,
    layer: row.layer,
    content: clip(row.content),
    gameTimeMs: row.gameTimeMs,
    provenance: row.provenance,
    confidence: row.confidence,
    sourceEventId: row.sourceEventId,
  };
}

function publicRelationship(row: RelationshipRow): PublicRelationship {
  return {
    otherId: row.otherId,
    name: row.name,
    trust: row.trust,
    affection: row.affection,
    respect: row.respect,
    fear: row.fear,
    debt: row.debt,
    grudge: row.grudge,
    suspicion: row.suspicion,
    dependence: row.dependence,
  };
}

function ownRelationships(db: WorldDatabase, citizenId: string): Array<RelationshipRow & { score: number }> {
  const rows = db.prepare(`SELECT r.other_id AS otherId, c.name, r.trust, r.affection, r.respect, r.fear,
      r.debt, r.grudge, r.suspicion, r.dependence, r.secrets_known AS secretsKnown
    FROM relationships r JOIN citizens c ON c.id = r.other_id
    WHERE r.citizen_id = ?
    ORDER BY (r.fear+r.grudge+r.suspicion+r.dependence+ABS(r.trust-50)+ABS(r.affection-50)+r.debt/100) DESC, r.other_id ASC
    LIMIT 6`).all(citizenId) as Array<RelationshipRow & { score: number }>;
  return rows;
}

function ownMemories(db: WorldDatabase, citizenId: string): MemoryRow[] {
  const layers = ['short_term', 'episodic', 'relationship', 'belief', 'long_term'];
  const result: MemoryRow[] = [];
  for (const layer of layers) {
    const priority = layer === 'episodic' || layer === 'long_term' ? 'importance DESC, ' : '';
    const rows = db.prepare(`SELECT id, layer, content, game_time_ms AS gameTimeMs,
        provenance, confidence, source_event_id AS sourceEventId
      FROM memories WHERE citizen_id = ? AND layer = ?
      ORDER BY ${priority}game_time_ms DESC, id DESC LIMIT 4`).all(citizenId, layer) as MemoryRow[];
    result.push(...rows);
  }
  return result;
}

export function citizenContext(db: WorldDatabase, citizenId: string): Record<string, unknown> {
  const citizen = db.prepare(`SELECT id, name, job, personality, goals, needs, mood, reputation, money
    FROM citizens WHERE id = ?`).get(citizenId) as CitizenRow | undefined;
  if (!citizen) throw new Error(`Unknown citizen: ${citizenId}`);

  const savingsRow = db.prepare('SELECT balance FROM bank_accounts WHERE citizen_id = ?').get(citizenId) as { balance: number } | undefined;
  const debts = db.prepare(`SELECT id, lender_account AS lenderAccount, outstanding, due_day AS dueDay, kind
    FROM debts WHERE borrower_account = ? AND outstanding > 0 ORDER BY due_day ASC, id ASC LIMIT 8`)
    .all(`citizen:${citizenId}`) as Array<Record<string, unknown>>;
  const secrets = db.prepare(`SELECT s.id, s.claim, k.confidence, k.source_event_id AS sourceEventId,
      k.source_citizen_id AS sourceCitizenId
    FROM secret_knowledge k JOIN secrets s ON s.id = k.secret_id
    WHERE k.citizen_id = ?
    ORDER BY k.confidence DESC, s.id ASC LIMIT 5`).all(citizenId) as Array<Record<string, unknown>>;
  const knowledge = db.prepare(`SELECT kind, claim, confidence, source_citizen_id AS sourceCitizenId,
      source_event_id AS sourceEventId, game_time_ms AS gameTimeMs
    FROM knowledge WHERE citizen_id = ?
    ORDER BY game_time_ms DESC, id DESC LIMIT 6`).all(citizenId) as Array<Record<string, unknown>>;
  const conversations = db.prepare(`SELECT id, game_time_ms AS gameTimeMs, speaker_id AS speakerId,
      recipient_id AS recipientId, text, visibility, source_event_id AS sourceEventId
    FROM conversations
    WHERE speaker_id = ? OR recipient_id = ?
    ORDER BY game_time_ms DESC, id DESC LIMIT 6`).all(citizenId, citizenId) as Array<Record<string, unknown>>;
  const clippedConversations = conversations
    .map((row) => ({ ...row, text: clip(String(row.text ?? '')) }));

  const relationships = ownRelationships(db, citizenId).map((row) => ({
    otherId: row.otherId,
    name: row.name,
    trust: row.trust,
    affection: row.affection,
    respect: row.respect,
    fear: row.fear,
    debt: row.debt,
    grudge: row.grudge,
    suspicion: row.suspicion,
    dependence: row.dependence,
      secretsKnown: parseIdList(row.secretsKnown).slice(0, 5),
  }));

  return {
    identity: { id: citizen.id, name: citizen.name, job: citizen.job },
    traits: parseJson(citizen.personality),
    needs: parseJson(citizen.needs),
    goals: parseJson(citizen.goals),
    mood: citizen.mood,
    reputation: citizen.reputation,
    cash: citizen.money,
    savings: savingsRow?.balance ?? 0,
    debtTotal: (db.prepare('SELECT COALESCE(SUM(outstanding),0) n FROM debts WHERE borrower_account=?').get(`citizen:${citizenId}`) as {n:number}).n,
    debts,
    relationships,
    secrets: secrets.map(row => ({ ...row, claim: clip(String(row.claim ?? '')) })),
    memories: ownMemories(db, citizenId).map(publicMemory),
    knowledge: knowledge.map(row => ({ ...row, claim: clip(String(row.claim ?? '')) })),
    conversations: clippedConversations,
  };
}

export function publicSocial(db: WorldDatabase, citizenId: string): PublicSocial | undefined {
  const citizen = db.prepare('SELECT id, reputation FROM citizens WHERE id = ?').get(citizenId) as { id: string; reputation: number } | undefined;
  if (!citizen) return undefined;

  const relationships = db.prepare(`SELECT r.other_id AS otherId, c.name, r.trust, r.affection, r.respect,
      r.fear, r.debt, r.grudge, r.suspicion, r.dependence, r.secrets_known AS secretsKnown
    FROM relationships r JOIN citizens c ON c.id = r.other_id
    WHERE r.citizen_id = ? ORDER BY r.other_id ASC`).all(citizenId) as RelationshipRow[];

  const memories = db.prepare(`SELECT m.id, m.layer, m.content, m.game_time_ms AS gameTimeMs,
      m.provenance, m.confidence, m.source_event_id AS sourceEventId
    FROM memories m
    JOIN events sourceEvent ON sourceEvent.id = m.source_event_id AND sourceEvent.visibility = 'public'
    WHERE m.citizen_id = ? AND m.visibility = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM memory_sources privateSource
        JOIN events privateEvent ON privateEvent.id = privateSource.event_id
        WHERE privateSource.memory_id = m.id AND privateEvent.visibility = 'private'
      )
    ORDER BY m.game_time_ms DESC, m.id DESC LIMIT 10`).all(citizenId) as MemoryRow[];

  return {
    citizenId: citizen.id,
    reputation: citizen.reputation,
    relationships: relationships.map(publicRelationship),
    memories: memories.map(publicMemory),
  };
}
