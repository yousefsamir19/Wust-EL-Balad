import { createHash } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import { GAME_DAY_MS, SimulationClock } from '../simulation/clock.js';
import { remember } from '../social/memories.js';
import type { SocialEvent } from '../social/types.js';
import type {
  InfluenceWallet,
  InterventionOutcome,
  InterventionRecord,
  InterventionResponse,
  InterventionStrength,
} from '../../../shared/influence.js';

type StrengthCosts = Record<InterventionStrength, number>;
type CommandClock = Pick<SimulationClock, 'state' | 'commitCommand'>;

type InterventionRow = {
  id: string;
  day: number;
  citizenId: string;
  strength: InterventionStrength;
  suggestion: string;
  cost: number;
  outcome: InterventionOutcome;
  eventId: number | null;
};

type CitizenRow = {
  id: string;
  personality: string;
  needs: string;
};

type ErrorCode = 'invalid' | 'unauthorized' | 'conflict' | 'unavailable';

const DEFAULT_COSTS: StrengthCosts = { subtle: 2, medium: 5, strong: 9 };
const STRENGTHS: readonly InterventionStrength[] = ['subtle', 'medium', 'strong'];
const HINT_BONUS: StrengthCosts = { subtle: 6, medium: 12, strong: 18 };
const GENERIC_EVENT_TEXT = 'Observer suggestion recorded for consideration';

export class InfluenceError extends Error {
  constructor(public readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'InfluenceError';
  }
}

function validCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100;
}

function readEnvironmentCost(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return validCost(value) ? value : fallback;
}

export function envInterventionCosts(): StrengthCosts {
  return {
    subtle: readEnvironmentCost('INTERVENTION_SUBTLE_COST', DEFAULT_COSTS.subtle),
    medium: readEnvironmentCost('INTERVENTION_MEDIUM_COST', DEFAULT_COSTS.medium),
    strong: readEnvironmentCost('INTERVENTION_STRONG_COST', DEFAULT_COSTS.strong),
  };
}

function normalizeCosts(costs?: StrengthCosts): StrengthCosts {
  const selected = costs ?? envInterventionCosts();
  if (!STRENGTHS.every((strength) => validCost(selected[strength]))) {
    throw new Error('Intervention costs must be positive safe integers no greater than 100.');
  }
  return { subtle: selected.subtle, medium: selected.medium, strong: selected.strong };
}

function dayFor(gameTimeMs: number): number {
  return Math.floor(gameTimeMs / GAME_DAY_MS) + 1;
}

function commandId(playerId: string, day: number): string {
  const id = `intervention:${playerId}:${day}`;
  if (!playerId || id.length > 128) throw new InfluenceError('invalid');
  return id;
}

function interventionRow(db: WorldDatabase, playerId: string, day: number): InterventionRow | undefined {
  return db.prepare(`SELECT id,day,citizen_id AS citizenId,strength,suggestion,cost,outcome,event_id AS eventId
    FROM interventions WHERE player_id = ? AND day = ?`).get(playerId, day) as InterventionRow | undefined;
}

function recordFrom(db: WorldDatabase, playerId: string, day: number): InterventionRecord | undefined {
  const row = interventionRow(db, playerId, day);
  return row ? { ...row } : undefined;
}

function samePayload(row: InterventionRow, citizenId: string, strength: InterventionStrength, suggestion: string): boolean {
  return row.citizenId === citizenId && row.strength === strength && row.suggestion === suggestion;
}

function normalizeSuggestion(value: unknown): string {
  if (typeof value !== 'string') throw new InfluenceError('invalid', 'suggestion');
  const suggestion = value.trim();
  if (!suggestion || Array.from(suggestion).length > 280 || /[<>]/.test(suggestion) || Array.from(suggestion).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) throw new InfluenceError('invalid', 'suggestion');
  return suggestion;
}

function normalizeCitizenId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) {
    throw new InfluenceError('invalid', 'citizen');
  }
  return value;
}

function normalizeStrength(value: unknown): InterventionStrength {
  if (!STRENGTHS.includes(value as InterventionStrength)) throw new InfluenceError('invalid', 'strength');
  return value as InterventionStrength;
}

function assertOpen(db: WorldDatabase): void {
  try {
    if (!db.open) throw new Error('closed');
  } catch {
    throw new InfluenceError('unavailable');
  }
}

function assertPlayer(db: WorldDatabase, playerId: string): { influence: number } {
  const player = db.prepare('SELECT influence,banned FROM players WHERE id = ?').get(playerId) as { influence: number; banned: number } | undefined;
  if (!player || player.banned !== 0) throw new InfluenceError('unauthorized');
  return player;
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boundedNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function hashPercent(playerId: string, day: number, citizenId: string, strength: InterventionStrength): number {
  const digest = createHash('sha256').update(`${playerId}\u0000${day}\u0000${citizenId}\u0000${strength}`).digest();
  return digest.readUInt32BE(0) % 10000;
}

function outcomeFor(
  playerId: string,
  day: number,
  citizenId: string,
  strength: InterventionStrength,
  citizen: CitizenRow,
): InterventionOutcome {
  const personality = parseJson(citizen.personality);
  const needs = parseJson(citizen.needs);
  const caution = boundedNumber(personality.caution, 50);
  const sociability = boundedNumber(personality.sociability, 50);
  const hunger = boundedNumber(needs.hunger, 50);
  const energy = boundedNumber(needs.energy, 50);
  const social = boundedNumber(needs.social, 50);
  const strain = Math.max(hunger, 100 - energy, social);
  const trait = typeof personality.trait === 'string' ? personality.trait.toLowerCase() : '';
  const traitCaution = ['careful', 'dutiful', 'practical', 'patient'].includes(trait) ? 8 : 0;
  const rejection = Math.min(3000, 450 + Math.round(caution * 10) + traitCaution * 20 + Math.round(Math.max(0, 25 - strain) * 4));
  const ignored = Math.min(3000, 1200 + Math.round(caution * 4) + Math.round(Math.max(0, 50 - sociability) * 3));
  const considered = Math.min(2400, 1500 + Math.round((100 - caution) * 2) + Math.round(sociability * 2));
  const baseAccepted = strength === 'subtle' ? 2800 : strength === 'medium' ? 4500 : 6500;
  const acceptance = Math.max(500, Math.min(7000, baseAccepted + Math.round(sociability * 4) - Math.round(caution * 3)));
  const roll = hashPercent(playerId, day, citizenId, strength);
  if (roll < rejection) return 'rejected';
  if (roll < rejection + ignored) return 'ignored';
  if (roll < rejection + ignored + considered) return 'considered';
  return roll < rejection + ignored + considered + acceptance ? 'accepted' : 'ignored';
}

function goalFor(suggestion: string): 'eat' | 'sleep' | 'work' | 'socialize' | 'idle' {
  const text = suggestion.toLowerCase();
  if (/\b(?:eat|food|meal|hungry|hunger)\b/.test(text)) return 'eat';
  if (/\b(?:sleep|rest|tired|energy)\b/.test(text)) return 'sleep';
  if (/\b(?:work|job|career|shift)\b/.test(text)) return 'work';
  if (/\b(?:social|friend|talk|visit|community)\b/.test(text)) return 'socialize';
  return 'idle';
}

function walletFor(db: WorldDatabase, playerId: string, day: number, costs: StrengthCosts): InfluenceWallet {
  const player = assertPlayer(db, playerId);
  const history = db.prepare(`SELECT id,day,citizen_id AS citizenId,strength,suggestion,cost,outcome,event_id AS eventId
    FROM interventions WHERE player_id = ? ORDER BY day DESC,id DESC LIMIT 20`).all(playerId) as InterventionRecord[];
  const used = !!interventionRow(db, playerId, day);
  return {
    balance: player.influence,
    day,
    available: !used && player.influence >= Math.min(...Object.values(costs)),
    costs: { ...costs },
    history: history.map((row) => ({ ...row })),
  };
}

function publicEvent(db: WorldDatabase, playerId: string, citizenId: string, suggestion: string, outcome: InterventionOutcome, stateVersion: number, gameTimeMs: number): number {
  const privateResult = db.prepare(`INSERT INTO events
    (world_version,game_time_ms,type,actor_id,target,importance,visibility,details)
    VALUES (?,?,?,?,?,0,'private',?)`).run(
    stateVersion,
    gameTimeMs,
    'intervention_suggestion_private',
    null,
    citizenId,
    JSON.stringify({ playerId, suggestion, outcome }),
  );
  const publicResult = db.prepare(`INSERT INTO events
    (world_version,game_time_ms,type,actor_id,target,importance,visibility,details,cause_id)
    VALUES (?,?,?,?,?,50,'public',?,?)`).run(
    stateVersion,
    gameTimeMs,
    'intervention_suggestion',
    null,
    citizenId,
    JSON.stringify({ text: GENERIC_EVENT_TEXT, witnessIds: [citizenId] }),
    privateResult.lastInsertRowid,
  );
  return Number(publicResult.lastInsertRowid);
}

function storeRecipientMemory(db: WorldDatabase, eventId: number, citizenId: string, suggestion: string, gameTimeMs: number): void {
  db.prepare('INSERT OR IGNORE INTO observed_events(citizen_id,event_id,mode) VALUES (?,?,?)').run(citizenId, eventId, 'told');
  const event = db.prepare(`SELECT id,world_version,game_time_ms,type,actor_id,target,amount,importance,visibility,details
    FROM events WHERE id = ?`).get(eventId) as SocialEvent;
  remember(db, event, citizenId, 'told', `Observer suggestion (not a fact): ${suggestion}`, null, 50);
  db.prepare('UPDATE memories SET visibility = \'private\' WHERE citizen_id = ? AND source_event_id = ?').run(citizenId, eventId);
  db.prepare(`INSERT OR IGNORE INTO citizen_brains(citizen_id,next_think_game_ms,last_event_id,pending_id,last_trigger)
    VALUES (?, ?, 0, NULL, 'intervention')`).run(citizenId, gameTimeMs);
  db.prepare('UPDATE citizen_brains SET next_think_game_ms = MIN(next_think_game_ms, ?) WHERE citizen_id = ?').run(gameTimeMs, citizenId);
}

export function activeHint(db: WorldDatabase, citizenId: string, gameTimeMs: number): { goal: string; bonus: number; eventId: number } | null {
  if (typeof gameTimeMs !== 'number' || !Number.isFinite(gameTimeMs)) return null;
  const row = db.prepare(`SELECT goal,bonus,event_id AS eventId FROM intervention_hints
    WHERE citizen_id = ? AND expires_game_ms > ? ORDER BY bonus DESC,expires_game_ms DESC,id DESC LIMIT 1`).get(citizenId, gameTimeMs) as { goal: string; bonus: number; eventId: number } | undefined;
  return row ? { goal: row.goal, bonus: row.bonus, eventId: row.eventId } : null;
}

export class InfluenceService {
  private readonly costs: StrengthCosts;

  constructor(private readonly db: WorldDatabase, private readonly clock: CommandClock, costs?: StrengthCosts) {
    this.costs = normalizeCosts(costs);
  }

  wallet(playerId: string): InfluenceWallet {
    assertOpen(this.db);
    if (typeof playerId !== 'string' || !playerId) throw new InfluenceError('invalid');
    const state = this.clock.state();
    return walletFor(this.db, playerId, dayFor(state.game_time_ms), this.costs);
  }

  submit(playerId: string, citizenId: string, strength: InterventionStrength, suggestion: string): InterventionResponse {
    assertOpen(this.db);
    if (typeof playerId !== 'string' || !playerId) throw new InfluenceError('invalid');
    const normalizedCitizenId = normalizeCitizenId(citizenId);
    const normalizedStrength = normalizeStrength(strength);
    const normalizedSuggestion = normalizeSuggestion(suggestion);
    assertPlayer(this.db, playerId);
    if (!this.db.prepare('SELECT id FROM citizens WHERE id = ?').get(normalizedCitizenId)) throw new InfluenceError('invalid', 'citizen');

    const before = this.clock.state();
    const day = dayFor(before.game_time_ms);
    const id = commandId(playerId, day);
    const existing = interventionRow(this.db, playerId, day);
    if (existing) {
      if (!samePayload(existing, normalizedCitizenId, normalizedStrength, normalizedSuggestion)) throw new InfluenceError('conflict', 'changed');
      return { intervention: { ...existing }, wallet: walletFor(this.db, playerId, day, this.costs) };
    }
    if (this.db.prepare('SELECT id FROM processed_commands WHERE id = ?').get(id)) throw new InfluenceError('conflict', 'stale command');

    this.clock.commitCommand(id, (db, state) => {
      assertPlayer(db, playerId);
      const currentDay = dayFor(state.game_time_ms);
      if (currentDay !== day) throw new InfluenceError('conflict', 'day changed');
      const insideExisting = interventionRow(db, playerId, currentDay);
      if (insideExisting) {
        if (!samePayload(insideExisting, normalizedCitizenId, normalizedStrength, normalizedSuggestion)) throw new InfluenceError('conflict', 'changed');
        return true;
      }
      if (db.prepare('SELECT result FROM processed_commands WHERE id = ?').get(id)) throw new InfluenceError('conflict', 'stale command');
      const citizen = db.prepare('SELECT id,personality,needs FROM citizens WHERE id = ?').get(normalizedCitizenId) as CitizenRow | undefined;
      if (!citizen) throw new InfluenceError('invalid', 'citizen');
      const cost = this.costs[normalizedStrength];
      const player = db.prepare('SELECT influence,banned FROM players WHERE id = ?').get(playerId) as { influence: number; banned: number } | undefined;
      if (!player || player.banned !== 0) throw new InfluenceError('unauthorized');
      if (player.influence < cost) throw new InfluenceError('invalid', 'insufficient balance');

      const outcome = outcomeFor(playerId, currentDay, normalizedCitizenId, normalizedStrength, citizen);
      const ledgerId = `intervention-debit:${playerId}:${currentDay}`;
      const debit = db.prepare('INSERT INTO influence_ledger(id,player_id,amount,reason,game_time_ms) VALUES (?,?,?,?,?)')
        .run(ledgerId, playerId, -cost, `intervention:${currentDay}`, state.game_time_ms);
      if (debit.changes !== 1) throw new InfluenceError('unavailable');
      const update = db.prepare('UPDATE players SET influence = influence - ? WHERE id = ? AND banned = 0 AND influence >= ?')
        .run(cost, playerId, cost);
      if (update.changes !== 1) throw new InfluenceError('invalid', 'insufficient balance');

      let eventId: number | null = null;
      if (outcome === 'accepted' || outcome === 'considered') {
        eventId = publicEvent(db, playerId, normalizedCitizenId, normalizedSuggestion, outcome, state.version, state.game_time_ms);
        storeRecipientMemory(db, eventId, normalizedCitizenId, normalizedSuggestion, state.game_time_ms);
      }
      db.prepare(`INSERT INTO interventions(id,player_id,day,citizen_id,strength,suggestion,cost,outcome,event_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, playerId, currentDay, normalizedCitizenId, normalizedStrength, normalizedSuggestion, cost, outcome, eventId);
      if (outcome === 'accepted' && eventId !== null) {
        db.prepare(`INSERT INTO intervention_hints(id,citizen_id,goal,bonus,expires_game_ms,event_id)
          VALUES (?,?,?,?,?,?)`).run(id, normalizedCitizenId, goalFor(normalizedSuggestion), HINT_BONUS[normalizedStrength], state.game_time_ms + GAME_DAY_MS, eventId);
      }
      return true;
    });

    const saved = recordFrom(this.db, playerId, day);
    if (!saved) throw new InfluenceError('unavailable');
    return { intervention: saved, wallet: walletFor(this.db, playerId, day, this.costs) };
  }
}
