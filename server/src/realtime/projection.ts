import type { WorldDatabase } from '../db/index.js';
import type { VisibleCitizen, TownBuilding } from '../../../shared/world.js';
import type { PublicEvent, WorldSnapshot } from '../../../shared/realtime.js';

export function visibleCitizens(db: WorldDatabase): VisibleCitizen[] {
  const rows = db.prepare(`SELECT c.id,c.name,c.job,c.x,c.y,c.mood,c.money,c.reputation,c.needs,c.building_id AS buildingId,c.activity,c.appearance,r.direction,
    (SELECT balance FROM bank_accounts WHERE citizen_id=c.id) AS savings,
    (SELECT COALESCE(SUM(outstanding),0) FROM debts WHERE borrower_account='citizen:'||c.id) AS debt
    FROM citizens c JOIN citizen_routines r ON r.citizen_id = c.id ORDER BY c.id`).all() as (Omit<VisibleCitizen, 'appearance' | 'needs' | 'publicThought'> & { appearance: string; needs: string })[];
  const thoughts: Record<string,string> = { walking:'I am on my way through downtown.', working:'Time to focus on my work.', eating:'A meal will help.', sleeping:'I need some rest.', socializing:'A conversation might help.', blocked:'I need another route.', idle:'A quiet moment in the city.', hungry:'I need a meal I can afford.',banking:'I need to look after my finances.',job_seeking:'I need steady work.' };
  return rows.map(({ appearance, needs, ...row }) => {
    const values = JSON.parse(needs) as VisibleCitizen['needs'];
    return { ...row, appearance: JSON.parse(appearance), needs: { hunger: values.hunger, energy: values.energy, social: values.social }, publicThought: thoughts[row.activity] ?? thoughts.idle };
  });
}
export function publicEvents(db: WorldDatabase, afterId = 0, limit = 40): PublicEvent[] {
  const rows = db.prepare(`SELECT id,game_time_ms AS gameTimeMs,type,actor_id AS actorId,target,amount,importance,details
    FROM events WHERE visibility='public' AND id > ? ORDER BY id DESC LIMIT ?`).all(afterId, limit) as (PublicEvent & { details: string })[];
  return rows.reverse().map(({ details, ...row }) => {
    const content = JSON.parse(details) as { text?: unknown; activity?: unknown };
    return { ...row, ...(typeof content.text === 'string' ? { text: content.text } : {}), ...(typeof content.activity === 'string' ? { activity: content.activity } : {}) };
  });
}
export function projectWorld(db: WorldDatabase, playerCount: number): WorldSnapshot {
  const state = db.prepare('SELECT game_time_ms,version,tick FROM world WHERE id=1').get() as { game_time_ms: number; version: number; tick: number };
  const minute = state.game_time_ms % 86400000 / 60000;
  return {
    version: state.version, tick: state.tick, gameTimeMs: state.game_time_ms,
    day: Math.floor(state.game_time_ms / 86400000) + 1, minute,
    lighting: minute >= 1080 && minute < 1200 ? 'sunset' : minute < 360 || minute >= 1200 ? 'night' : 'day',
    playerCount, citizens: visibleCitizens(db), buildings: db.prepare('SELECT * FROM buildings ORDER BY id').all() as TownBuilding[],
    events: publicEvents(db),
  };
}
