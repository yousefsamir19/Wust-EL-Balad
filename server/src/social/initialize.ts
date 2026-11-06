import type { WorldDatabase } from '../db/index.js';
export function initializeSocial(db:WorldDatabase) {
  const {game_time_ms:time}=db.prepare('SELECT game_time_ms FROM world WHERE id=1').get() as {game_time_ms:number};
  const {n:max}=db.prepare('SELECT COALESCE(MAX(id),0) n FROM events').get() as {n:number};
  db.prepare('INSERT OR IGNORE INTO social_cursor VALUES(1,?)').run(max);
  db.prepare('INSERT OR IGNORE INTO social_state SELECT id,?,? FROM citizens').run(Math.floor(time/86400000)+1,time);
  db.prepare(`UPDATE relationships SET secrets_known=COALESCE((SELECT json_group_array(s.id) FROM secrets s
    JOIN secret_knowledge k ON k.secret_id=s.id WHERE k.citizen_id=relationships.citizen_id AND s.owner_id=relationships.other_id),'[]')`).run();
}
