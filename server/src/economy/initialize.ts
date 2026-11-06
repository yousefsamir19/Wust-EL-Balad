import type { WorldDatabase } from '../db/index.js';
import { businessDefaults, DAY_MS } from './types.js';
export function initializeEconomy(db:WorldDatabase) {
  const {game_time_ms:time}=db.prepare('SELECT game_time_ms FROM world WHERE id=1').get() as {game_time_ms:number};
  const day=Math.floor(time/DAY_MS)+1;
  for(const [id,config] of Object.entries(businessDefaults)) db.prepare('INSERT OR IGNORE INTO businesses VALUES (?,?,?,?,?,?,?)').run(id,config.owner,1000000,id==='cafe'||id==='store'?80:0,config.wage,config.capacity,config.job);
  for(const [id,balance] of [['bank-reserve',5000000],['landlord',0],['supplier',0]] as const) db.prepare('INSERT OR IGNORE INTO system_wallets VALUES (?,?)').run(id,balance);
  db.prepare('INSERT OR IGNORE INTO bank_accounts(citizen_id) SELECT id FROM citizens').run();
  db.prepare('INSERT OR IGNORE INTO economic_state(citizen_id) SELECT id FROM citizens').run();
  db.prepare(`INSERT OR IGNORE INTO employment(citizen_id,business_id,work_day,active,wage_settled)
    SELECT c.id,c.workplace_id,?,CASE WHEN c.workplace_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN ? >= s.shift_end THEN 1 ELSE 0 END FROM citizens c JOIN schedules s ON s.citizen_id=c.id`).run(day,time%DAY_MS/60000);
  db.prepare('INSERT OR IGNORE INTO economy_days VALUES (?)').run(day);
}
