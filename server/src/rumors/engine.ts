import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { captureCitizenFrame, applyCitizenAction } from '../citizens/actions.js';
import { remember } from '../social/memories.js';
import type { SocialEvent } from '../social/types.js';

const GAME_DAY_MS = 86_400_000;
const SPREAD_INTERVAL_MS = 15 * 60_000;
const PUBLICATION_LIFETIME_MS = 3 * GAME_DAY_MS;
const CLAIM_TEXT_LIMIT = 240;
const CLAIM_PREFIX = 'Unconfirmed rumor: ';
const TRANSFER_PREFIX = 'I heard unconfirmed rumor: ';

type RumorStatus = 'pending' | 'published' | 'expired';

type RumorRow = {
  id: string;
  proposer_id: string;
  text: string;
  revision: number;
  status: RumorStatus;
  proposed_day: number;
  expires_at: number;
  published_game_ms: number | null;
  published_event_id: number | null;
  voter_snapshot: string;
  last_spread_game_ms: number;
};

type HeardRow = {
  rumor_id: string;
  citizen_id: string;
  confidence: number;
  source_event_id: number;
  last_shared_game_ms: number;
};

type CitizenRow = {
  id: string;
  name: string;
  activity: string;
  building_id: string | null;
  x: number;
  y: number;
  money: number;
  workplace_id: string | null;
};

type EventRow = SocialEvent;

function requireTransaction(db: WorldDatabase): void {
  if (!db.inTransaction) throw new Error('Rumor operations require an active transaction.');
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function claimFor(text: string): string {
  return `${CLAIM_PREFIX}${text.trim().slice(0, CLAIM_TEXT_LIMIT)}`.slice(0, 280);
}

function transferText(text: string): string {
  return `${TRANSFER_PREFIX}${text.trim().slice(0, CLAIM_TEXT_LIMIT)}`.slice(0, 280);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function ordered<T>(values: T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => hash(key(a)) - hash(key(b)) || key(a).localeCompare(key(b)));
}

function sameSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function knownAccused(db: WorldDatabase, text: string): string | null {
  const normalized = text.toLocaleLowerCase();
  const citizens = db.prepare('SELECT id, name FROM citizens ORDER BY LENGTH(name) DESC, id ASC').all() as Array<{ id: string; name: string }>;
  for (const citizen of citizens) {
    for (const candidate of [citizen.name, citizen.id]) {
      const needle = candidate.toLocaleLowerCase();
      let start = normalized.indexOf(needle);
      while (start >= 0) {
        const before = start === 0 ? '' : normalized[start - 1];
        const after = normalized[start + needle.length] ?? '';
        const word = (character: string) => !character || !/[\p{L}\p{N}_]/u.test(character);
        if (word(before) && word(after)) return citizen.id;
        start = normalized.indexOf(needle, start + needle.length);
      }
    }
  }
  return null;
}

function publicationEvent(db: WorldDatabase, eventId: number): EventRow {
  const event = db.prepare(`SELECT id, world_version, game_time_ms, type, actor_id, target, amount,
      importance, visibility, details FROM events WHERE id = ?`).get(eventId) as EventRow | undefined;
  if (!event) throw new Error('Rumor publication event was not created.');
  return event;
}

function relationshipConsequence(db: WorldDatabase, citizenId: string, accusedId: string | null): void {
  if (!accusedId || citizenId === accusedId) return;
  db.prepare(`UPDATE relationships
    SET suspicion = MIN(100, suspicion + 3),
        fear = MIN(100, fear + 1),
        trust = MAX(0, trust - 2)
    WHERE citizen_id = ? AND other_id = ?`).run(citizenId, accusedId);
}

function authorizeAndRemember(
  db: WorldDatabase,
  event: EventRow,
  citizenId: string,
  confidence: number,
  claim: string,
): void {
  db.prepare('INSERT OR IGNORE INTO observed_events(citizen_id,event_id,mode) VALUES(?,?,?)')
    .run(citizenId, event.id, 'told');
  remember(db, event, citizenId, 'rumor', claim, null, Math.max(0, Math.min(100, Math.round(confidence))));
}

function heardFor(db: WorldDatabase, rumorId: string, citizenId: string): HeardRow | undefined {
  return db.prepare(`SELECT rumor_id, citizen_id, confidence, source_event_id, last_shared_game_ms
    FROM rumor_heard WHERE rumor_id = ? AND citizen_id = ?`).get(rumorId, citizenId) as HeardRow | undefined;
}

function seedRumor(db: WorldDatabase, world: WorldState, rumor: RumorRow, publication: EventRow): void {
  if (rumor.published_game_ms === null || world.game_time_ms >= rumor.published_game_ms + PUBLICATION_LIFETIME_MS) return;
  const current = db.prepare('SELECT citizen_id FROM rumor_heard WHERE rumor_id = ?').all(rumor.id) as Array<{ citizen_id: string }>;
  if (current.length >= 2) return;
  const alreadyHeard = new Set(current.map((row) => row.citizen_id));
  const candidates = db.prepare(`SELECT id, name, activity, building_id, x, y, money, workplace_id
    FROM citizens WHERE activity != 'sleeping'`).all() as CitizenRow[];
  const claim = claimFor(rumor.text);
  const accused = publication.target;
  for (const citizen of ordered(candidates, (row) => `${rumor.id}:seed:${row.id}`)) {
    if (alreadyHeard.has(citizen.id)) continue;
    const result = db.prepare(`INSERT OR IGNORE INTO rumor_heard
      (rumor_id, citizen_id, confidence, source_event_id, last_shared_game_ms)
      VALUES (?, ?, ?, ?, ?)`).run(rumor.id, citizen.id, 35, publication.id, world.game_time_ms);
    if (!result.changes) continue;
    authorizeAndRemember(db, publication, citizen.id, 35, claim);
    relationshipConsequence(db, citizen.id, accused);
    alreadyHeard.add(citizen.id);
    if (alreadyHeard.size >= 2) break;
  }
}

function knowledgeConfidence(db: WorldDatabase, citizenId: string, claim: string): number | null {
  const row = db.prepare(`SELECT confidence FROM knowledge
    WHERE citizen_id = ? AND kind = 'rumor' AND claim = ? ORDER BY id DESC LIMIT 1`).get(citizenId, claim) as { confidence: number } | undefined;
  return row?.confidence ?? null;
}

function synchronizeHeardConfidence(db: WorldDatabase, rumor: RumorRow): void {
  const claim = claimFor(rumor.text);
  const heard = db.prepare('SELECT * FROM rumor_heard WHERE rumor_id = ?').all(rumor.id) as HeardRow[];
  for (const row of heard) {
    const current = knowledgeConfidence(db, row.citizen_id, claim);
    const confidence = current === null ? 0 : Math.max(0, Math.min(100, Math.round(current)));
    if (confidence >= row.confidence) continue;
    db.prepare('UPDATE rumor_heard SET confidence = ? WHERE rumor_id = ? AND citizen_id = ?')
      .run(confidence, rumor.id, row.citizen_id);
  }
}

function observedContradiction(
  db: WorldDatabase,
  rumor: RumorRow,
  heard: HeardRow,
  accusedId: string | null,
): boolean {
  if (!accusedId || rumor.published_game_ms === null) return false;
  const claim = rumor.text.toLocaleLowerCase();
  const citizen = db.prepare('SELECT id, money, workplace_id FROM citizens WHERE id = ?').get(heard.citizen_id) as { id: string; money: number; workplace_id: string | null } | undefined;
  if (!citizen) return false;

  const witnessed = db.prepare(`SELECT e.type, e.actor_id, e.target, e.details, e.game_time_ms
    FROM observed_events oe JOIN events e ON e.id = oe.event_id
    WHERE oe.citizen_id = ? AND oe.mode = 'observation' ORDER BY e.game_time_ms ASC, e.id ASC`)
    .all(heard.citizen_id) as Array<{ type: string; actor_id: string | null; target: string | null; details: string; game_time_ms: number }>;

  const saysNeverPaidRent = /\bnever\s+(?:paid|pay)\s+(?:the\s+)?rent\b/i.test(claim);
  const saysLostJob = /\b(?:lost|left|quit|has no|does not have|is without)\s+(?:his|her|their|the)?\s*(?:job|work|employment)\b/i.test(claim)
    || /\b(?:unemployed|jobless|out of work)\b/i.test(claim);
  if (saysNeverPaidRent && witnessed.some((event) => event.type === 'rent_paid' && event.actor_id === accusedId)) return true;
  if (saysLostJob && witnessed.some((event) =>
    event.game_time_ms >= rumor.published_game_ms! && event.actor_id === accusedId && (event.type === 'employment_started' || event.type === 'wage_paid' ||
      (event.type === 'citizen_arrived' && (()=>{try{return JSON.parse(event.details).activity==='working';}catch{return false;}})())))) return true;

  // A citizen may compare a self-reported financial claim with only their own balance.
  if (heard.citizen_id === accusedId && citizen.money > 0 &&
      /\b(?:has|have)\s+no\s+(?:money|cash)\b|\b(?:broke|penniless)\b/.test(claim)) return true;
  return false;
}

function reduceContradictedBelief(db: WorldDatabase, rumor: RumorRow, heard: HeardRow): void {
  const claim = claimFor(rumor.text);
  db.prepare(`UPDATE rumor_heard SET confidence = 0
    WHERE rumor_id = ? AND citizen_id = ?`).run(rumor.id, heard.citizen_id);
  db.prepare(`UPDATE knowledge SET confidence = 0
    WHERE citizen_id = ? AND kind = 'rumor' AND claim = ?`).run(heard.citizen_id, claim);
  db.prepare(`UPDATE memories SET confidence = 0
    WHERE citizen_id = ? AND provenance = 'rumor' AND content = ?`).run(heard.citizen_id, claim);
}

function transferRumor(db: WorldDatabase, world: WorldState, rumor: RumorRow, publication: EventRow): boolean {
  if (rumor.published_game_ms === null || world.game_time_ms >= rumor.published_game_ms + PUBLICATION_LIFETIME_MS) return false;
  if (rumor.last_spread_game_ms > world.game_time_ms - SPREAD_INTERVAL_MS) return false;
  const claim = claimFor(rumor.text);
  const holders = db.prepare(`SELECT h.rumor_id, h.citizen_id, h.confidence, h.source_event_id, h.last_shared_game_ms
    FROM rumor_heard h JOIN citizens c ON c.id = h.citizen_id
    WHERE h.rumor_id = ? AND h.confidence > 0 AND c.activity != 'sleeping'`).all(rumor.id) as HeardRow[];
  const people = new Map((db.prepare(`SELECT id, name, activity, building_id, x, y, money, workplace_id
    FROM citizens`).all() as CitizenRow[]).map((person) => [person.id, person]));
  for (const holder of ordered(holders, (row) => `${rumor.id}:speaker:${row.citizen_id}`)) {
    const speaker = people.get(holder.citizen_id);
    if (!speaker || speaker.activity === 'sleeping') continue;
    const frame = captureCitizenFrame(db, world, speaker.id, 'rumor_spread');
    if (!frame.canSpeak) continue;
    const source = frame.sources.find((item) => item.id.startsWith('knowledge:') && item.kind === 'rumor' && item.claim === claim);
    if (!source) continue;
    const peers = ordered(frame.nearby.filter((peer) => people.get(peer.id)?.activity !== 'sleeping'), (peer) => `${rumor.id}:peer:${peer.id}`);
    for (const peer of peers) {
      if (peer.id === speaker.id || heardFor(db, rumor.id, peer.id)) continue;
      const action = {
        action: 'speak',
        target: peer.id,
        goal: 'idle',
        amount: 0,
        text: transferText(rumor.text),
        stance: 'belief',
        sources: [source.id],
      };
      const result = applyCitizenAction(db, world, frame, action, `rumor:${rumor.id}:${speaker.id}:${peer.id}`, 'local');
      if (!result.accepted || result.eventId === undefined) continue;
      const confidence = Math.max(0, Math.min(100, holder.confidence - 5));
      const conversation = publicationEvent(db, result.eventId);
      db.prepare(`INSERT INTO rumor_heard
        (rumor_id, citizen_id, confidence, source_event_id, last_shared_game_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rumor_id, citizen_id) DO UPDATE SET
          confidence = MIN(rumor_heard.confidence, excluded.confidence),
          source_event_id = excluded.source_event_id,
          last_shared_game_ms = excluded.last_shared_game_ms`)
        .run(rumor.id, peer.id, confidence, conversation.id, world.game_time_ms);
      authorizeAndRemember(db, conversation, peer.id, confidence, claim);
      relationshipConsequence(db, peer.id, publication.target);
      db.prepare('UPDATE rumor_heard SET last_shared_game_ms = ? WHERE rumor_id = ? AND citizen_id = ?')
        .run(world.game_time_ms, rumor.id, speaker.id);
      db.prepare('UPDATE rumors SET last_spread_game_ms = ? WHERE id = ?')
        .run(world.game_time_ms, rumor.id);
      return true;
    }
  }
  return false;
}

/** Expire wall-clock deadlines. This never advances the authoritative game clock. */
export function expireRumors(db: WorldDatabase, world: WorldState, nowMs = Date.now()): void {
  requireTransaction(db);
  void world;
  requireFinite(nowMs, 'Rumor expiry time');
  db.prepare(`UPDATE rumors SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= ?`).run(nowMs);
}

/** Publish exactly one current, unanimously approved pending rumor. */
export function publishRumor(db: WorldDatabase, world: WorldState, id: string, voterIds: string[]): void {
  requireTransaction(db);
  requireFinite(world.game_time_ms, 'World game time');
  expireRumors(db, world, Date.now());
  const rumor = db.prepare('SELECT * FROM rumors WHERE id = ?').get(id) as RumorRow | undefined;
  if (!rumor || rumor.status !== 'pending' || rumor.expires_at <= Date.now()) return;

  const registered = (db.prepare('SELECT id FROM players WHERE banned = 0 ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id);
  const supplied = uniqueStrings(voterIds);
  const approved = (db.prepare(`SELECT p.id FROM players p
    JOIN rumor_approvals a ON a.player_id = p.id AND a.rumor_id = ? AND a.revision = ?
    WHERE p.banned = 0 ORDER BY p.id`).all(rumor.id, rumor.revision) as Array<{ id: string }>).map((row) => row.id);
  if (registered.length === 0 || !sameSet(supplied, registered) || !sameSet(approved, registered)) return;

  const text = claimFor(rumor.text);
  const target = knownAccused(db, rumor.text);
  const event = db.prepare(`INSERT INTO events
    (world_version, game_time_ms, type, actor_id, target, importance, visibility, details)
    VALUES (?, ?, 'rumor_published', NULL, ?, 60, 'public', ?)`).run(
    world.version,
    world.game_time_ms,
    target,
    JSON.stringify({ text, witnessIds: [] }),
  );
  const eventId = Number(event.lastInsertRowid);
  db.prepare(`UPDATE rumors SET status = 'published', published_game_ms = ?, published_event_id = ?,
      voter_snapshot = ?, last_spread_game_ms = ? WHERE id = ? AND status = 'pending'`)
    .run(world.game_time_ms, eventId, JSON.stringify(supplied), world.game_time_ms, rumor.id);
  const publication = publicationEvent(db, eventId);
  seedRumor(db, world, { ...rumor, status: 'published', published_game_ms: world.game_time_ms, published_event_id: eventId, voter_snapshot: JSON.stringify(supplied), last_spread_game_ms: world.game_time_ms }, publication);
}

/** Advance rumor expiry, bounded seeding, confidence synchronization, contradiction handling, and spread. */
export function advanceRumors(db: WorldDatabase, world: WorldState, nowMs = Date.now()): void {
  requireTransaction(db);
  requireFinite(world.game_time_ms, 'World game time');
  expireRumors(db, world, nowMs);
  const pending = db.prepare(`SELECT id FROM rumors WHERE status = 'pending' AND expires_at > ? ORDER BY proposed_day ASC, id ASC`).all(nowMs) as Array<{ id: string }>;
  for (const row of pending) {
    const currentVoters = (db.prepare('SELECT id FROM players WHERE banned = 0 ORDER BY id').all() as Array<{ id: string }>).map((voter) => voter.id);
    if (currentVoters.length === 0) continue;
    publishRumor(db, world, row.id, currentVoters);
  }
  const rumors = db.prepare(`SELECT * FROM rumors WHERE status = 'published'
    ORDER BY published_game_ms ASC, id ASC`).all() as RumorRow[];
  for (const rumor of rumors) {
    if (rumor.published_event_id === null || rumor.published_game_ms === null) continue;
    const publication = publicationEvent(db, rumor.published_event_id);
    synchronizeHeardConfidence(db, rumor);
    seedRumor(db, world, rumor, publication);
    const heard = db.prepare('SELECT * FROM rumor_heard WHERE rumor_id = ? AND confidence > 0').all(rumor.id) as HeardRow[];
    for (const row of heard) {
      if (observedContradiction(db, rumor, row, publication.target)) reduceContradictedBelief(db, rumor, row);
    }
    const current = db.prepare('SELECT * FROM rumors WHERE id = ?').get(rumor.id) as RumorRow;
    transferRumor(db, world, current, publication);
  }
}
