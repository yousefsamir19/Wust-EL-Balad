import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { WorldDatabase } from '../db/index.js';
import { advanceCitizens } from '../citizens/routines.js';
import { advanceEconomy } from '../economy/lifecycle.js';
import { advanceSocial } from '../social/engine.js';

export const GAME_DAY_MS = 86400000;
export interface WorldState { game_time_ms: number; version: number; tick: number }
interface Options { dayDurationHours?: number; tickMs?: number; onError?: (error: Error) => void }

export class SimulationClock {
  private readonly owner = randomUUID();
  private readonly dayDurationHours: number;
  private readonly tickMs: number;
  private readonly leaseMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: WorldDatabase, private readonly options: Options = {}) {
    this.dayDurationHours = options.dayDurationHours ?? Number(process.env.DAY_DURATION_HOURS ?? 6);
    this.tickMs = options.tickMs ?? Number(process.env.SIMULATION_TICK_MS ?? 1000);
    if (!Number.isFinite(this.dayDurationHours) || this.dayDurationHours <= 0) throw new Error('DAY_DURATION_HOURS must be positive');
    if (!Number.isInteger(this.tickMs) || this.tickMs < 10 || this.tickMs > 60000) throw new Error('SIMULATION_TICK_MS must be between 10 and 60000');
    this.leaseMs = Math.max(15000, this.tickMs * 4);
    db.transaction(() => {
      const lock = db.prepare('SELECT owner_id, expires_at FROM simulation_lock WHERE id = 1').get() as { owner_id: string; expires_at: number } | undefined;
      if (lock && lock.expires_at > Date.now()) throw new Error('World already has an active simulation. After an unclean stop, wait for its lease to expire.');
      db.prepare('INSERT OR REPLACE INTO simulation_lock VALUES (1, ?, ?)').run(this.owner, Date.now() + this.leaseMs);
    })();
  }

  state(): WorldState {
    return this.db.prepare('SELECT game_time_ms, version, tick FROM world WHERE id = 1').get() as WorldState;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { console.error('A post-commit world subscriber failed.'); }
    }
  }

  private assertOwner() {
    if (this.stopped) throw new Error('Simulation is stopped');
    const lock = this.db.prepare('SELECT owner_id FROM simulation_lock WHERE id = 1').get() as { owner_id: string } | undefined;
    if (lock?.owner_id !== this.owner) throw new Error('Simulation lost its writer lease');
    this.db.prepare('UPDATE simulation_lock SET expires_at = ? WHERE id = 1 AND owner_id = ?').run(Date.now() + this.leaseMs, this.owner);
  }

  step(realElapsedMs: number): WorldState {
    if (!Number.isFinite(realElapsedMs) || realElapsedMs < 0) throw new Error('Elapsed time must be nonnegative and finite');
    const committed = this.db.transaction(() => {
      this.assertOwner();
      const previous = this.state();
      const next = { game_time_ms: previous.game_time_ms + Math.round(realElapsedMs * 24 / this.dayDurationHours), version: previous.version + 1, tick: previous.tick + 1 };
      const firstDay = Math.floor(previous.game_time_ms / GAME_DAY_MS) + 1;
      const lastDay = Math.floor(next.game_time_ms / GAME_DAY_MS) + 1;
      for (let day = firstDay; day < lastDay; day++) {
        if (this.db.prepare('SELECT day FROM closed_days WHERE day = ?').get(day)) continue;
        const boundary = day * GAME_DAY_MS;
        const result = this.db.prepare(`INSERT INTO events
          (world_version,game_time_ms,type,importance,visibility,details) VALUES (?,?,?,0,'public',?)`)
          .run(next.version, boundary, 'day_ended', JSON.stringify({ day }));
        this.db.prepare('INSERT INTO closed_days VALUES (?,?,?)').run(day, boundary, result.lastInsertRowid);
      }
      advanceEconomy(this.db, next, previous);
      advanceCitizens(this.db, next, realElapsedMs, next.game_time_ms - previous.game_time_ms);
      advanceSocial(this.db, next);
      this.db.prepare('UPDATE world SET game_time_ms = ?, version = ?, tick = ?, updated_at = ? WHERE id = 1')
        .run(next.game_time_ms, next.version, next.tick, new Date().toISOString());
      return next;
    })();
    this.notify();
    return committed;
  }

  commitCommand<T>(id: string, action: (db: WorldDatabase, state: WorldState) => T): T {
    if (!id || id.length > 128) throw new Error('A command id is required');
    const beforeVersion = this.state().version;
    const committed = this.db.transaction(() => {
      this.assertOwner();
      const saved = this.db.prepare('SELECT result FROM processed_commands WHERE id = ?').get(id) as { result: string } | undefined;
      if (saved) return JSON.parse(saved.result) as T;
      const previous = this.state();
      const result = action(this.db, previous);
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error('Command results must be JSON serializable');
      const version = previous.version + 1;
      advanceSocial(this.db, { ...previous, version });
      this.db.prepare('UPDATE world SET version = ?, updated_at = ? WHERE id = 1').run(version, new Date().toISOString());
      this.db.prepare('INSERT INTO processed_commands VALUES (?,?,?)').run(id, serialized, version);
      return result;
    })();
    if (this.state().version !== beforeVersion) this.notify();
    return committed;
  }

  start() {
    if (this.stopped) throw new Error('Simulation is stopped');
    if (this.timer) return;
    let previous = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      // Do not replay downtime or a suspended process as a backlog of missed days.
      const elapsed = Math.min(now - previous, this.tickMs * 5);
      previous = now;
      try { this.step(elapsed); }
      catch (failure) {
        this.stop();
        const error = failure instanceof Error ? failure : new Error('Simulation failed');
        if (this.options.onError) this.options.onError(error);
        else console.error(error.message);
      }
    }, this.tickMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.stopped && this.db.open) {
      try { this.db.prepare('DELETE FROM simulation_lock WHERE owner_id = ?').run(this.owner); }
      catch { console.error('Could not release the simulation lease; it will expire automatically.'); }
    }
    this.stopped = true;
  }
}
