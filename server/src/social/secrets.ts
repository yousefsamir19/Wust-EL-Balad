import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { requireTransaction } from '../economy/wallets.js';
export function shareSecret(db:WorldDatabase,world:WorldState,speakerId:string,recipientId:string,secretId:string) {
  requireTransaction(db);
  return db.transaction(()=>{
    const held=db.prepare(`SELECT s.claim,s.owner_id,k.confidence FROM secrets s JOIN secret_knowledge k ON k.secret_id=s.id WHERE s.id=? AND k.citizen_id=?`).get(secretId,speakerId) as {claim:string;owner_id:string;confidence:number}|undefined;
    if(!held||held.claim.length>500)throw new Error('Speaker cannot transmit that secret');
    const people=db.prepare('SELECT id,x,y,building_id FROM citizens WHERE id IN (?,?)').all(speakerId,recipientId) as {id:string;x:number;y:number;building_id:string|null}[];
    const a=people.find(p=>p.id===speakerId),b=people.find(p=>p.id===recipientId);
    if(!a||!b||speakerId===recipientId||a.building_id!==b.building_id||Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>3)throw new Error('Private conversation requires both people together');
    const trust=(db.prepare('SELECT trust FROM relationships WHERE citizen_id=? AND other_id=?').get(recipientId,speakerId) as {trust:number}).trust;
    const confidence=Math.min(90,Math.floor(held.confidence*trust/100));
    const text=`I wanted to tell you: ${held.claim}`;
    const event=Number(db.prepare(`INSERT INTO events(world_version,game_time_ms,type,actor_id,target,visibility,details) VALUES (?,?,?,?,?,'private',?)`).run(world.version,world.game_time_ms,'citizen_spoke',speakerId,recipientId,JSON.stringify({text,secretId})).lastInsertRowid);
    db.prepare("INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,visibility,source_event_id) VALUES (?,?,?,?,'private',?)").run(world.game_time_ms,speakerId,recipientId,text,event);
    db.prepare(`INSERT INTO secret_knowledge(secret_id,citizen_id,confidence,source_event_id,source_citizen_id) VALUES(?,?,?,?,?)
      ON CONFLICT(secret_id,citizen_id) DO UPDATE SET
      source_event_id=CASE WHEN excluded.confidence>=confidence THEN excluded.source_event_id ELSE source_event_id END,
      source_citizen_id=CASE WHEN excluded.confidence>=confidence THEN excluded.source_citizen_id ELSE source_citizen_id END,
      confidence=MAX(confidence,excluded.confidence)`).run(secretId,recipientId,confidence,event,speakerId);
    if(held.owner_id!==recipientId) {
      const ids=(db.prepare('SELECT secrets_known FROM relationships WHERE citizen_id=? AND other_id=?').get(recipientId,held.owner_id) as {secrets_known:string}).secrets_known;
      const known=JSON.parse(ids) as string[];
      if(!known.includes(secretId))db.prepare('UPDATE relationships SET secrets_known=? WHERE citizen_id=? AND other_id=?').run(JSON.stringify([...known,secretId]),recipientId,held.owner_id);
    }
    return event;
  })();
}
