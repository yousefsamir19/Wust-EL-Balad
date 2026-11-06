import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { citizenContext } from '../social/context.js';
import { transferMoney } from '../economy/wallets.js';
import { entrance,findPath,tileKey,walkable } from '../simulation/navigation.js';
import type { TownBuilding } from '../../../shared/world.js';
import type { ActionResult,CitizenAction,ReasoningFrame } from './reasoning-types.js';
interface Person {id:string;name:string;job:string;money:number;x:number;y:number;building_id:string|null;home_id:string;workplace_id:string|null;activity:string;mood:string;needs:string}
const person=(db:WorldDatabase,id:string)=>db.prepare('SELECT id,name,job,money,x,y,building_id,home_id,workplace_id,activity,mood,needs FROM citizens WHERE id=?').get(id) as Person|undefined;
export function captureCitizenFrame(db:WorldDatabase,world:WorldState,citizenId:string,trigger='routine'):ReasoningFrame {
  const p=person(db,citizenId);if(!p)throw new Error('Unknown citizen');
  const context=citizenContext(db,citizenId),nearby=db.prepare(`SELECT c.id,c.name,c.job,r.trust,r.affection,r.fear,r.grudge,r.suspicion FROM citizens c JOIN relationships r ON r.other_id=c.id AND r.citizen_id=? WHERE c.id!=? AND c.building_id IS ? AND ABS(c.x-?)+ABS(c.y-?)<=3 ORDER BY r.trust+r.affection-r.fear-r.grudge-r.suspicion DESC,c.id LIMIT 5`).all(citizenId,citizenId,p.building_id,p.x,p.y) as ReasoningFrame['nearby'];
  const sources:ReasoningFrame['sources']=[];
  for(const row of context.memories as {id:number;provenance:string;content:string;confidence:number}[])sources.push({id:`memory:${row.id}`,kind:row.provenance,claim:row.content,confidence:row.confidence});
  for(const row of db.prepare('SELECT id,kind,claim,confidence FROM knowledge WHERE citizen_id=? ORDER BY game_time_ms DESC,id DESC LIMIT 6').all(citizenId) as {id:number;kind:string;claim:string;confidence:number}[])sources.push({id:`knowledge:${row.id}`,kind:row.kind,claim:row.claim.slice(0,280),confidence:row.confidence});
  for(const row of context.secrets as {id:string;claim:string;confidence:number}[])sources.push({id:`secret:${row.id}`,kind:'belief',claim:row.claim,confidence:row.confidence});
  for(const row of context.conversations as {id:number;speakerId:string;text:string}[])sources.push({id:`conversation:${row.id}`,kind:row.speakerId===citizenId?'observation':'told',claim:row.text,confidence:row.speakerId===citizenId?100:60});
  const routine=db.prepare('SELECT next_speech_game_ms FROM citizen_routines WHERE citizen_id=?').get(citizenId) as {next_speech_game_ms:number};
  return {citizenId,gameTimeMs:world.game_time_ms,worldVersion:world.version,self:{id:p.id,name:p.name,job:p.job,money:p.money,x:p.x,y:p.y,buildingId:p.building_id,homeId:p.home_id,workplaceId:p.workplace_id,activity:p.activity,mood:p.mood,needs:JSON.parse(p.needs)},context,nearby,buildings:db.prepare('SELECT * FROM buildings ORDER BY id').all() as TownBuilding[],sources,canSpeak:p.activity!=='sleeping'&&routine.next_speech_game_ms<=world.game_time_ms,trigger};
}
export function parseCitizenAction(raw:unknown):CitizenAction {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid action');const p=raw as Record<string,unknown>,fields=['action','target','goal','amount','text','stance','sources'];
  if(Object.keys(p).length!==fields.length||Object.keys(p).some(k=>!fields.includes(k))||!['wait','go','speak','transfer'].includes(String(p.action))||!['idle','work','eat','sleep','socialize','bank'].includes(String(p.goal))||!['personal','observation','told','belief','lie'].includes(String(p.stance))||typeof p.target!=='string'||p.target.length>64||typeof p.text!=='string'||p.text.length>280||Array.from(p.text).some(c=>c.charCodeAt(0)<32&&!['\t','\n','\r'].includes(c))||!Number.isSafeInteger(p.amount)||Number(p.amount)<0||Number(p.amount)>100000||!Array.isArray(p.sources)||p.sources.length>8||p.sources.some(v=>typeof v!=='string'||v.length>100)||new Set(p.sources).size!==p.sources.length)throw new Error('Invalid action');
  const result=p as unknown as CitizenAction;
  if(result.action==='wait'&&(result.target||result.amount||result.text||result.sources.length)||result.action==='go'&&(!result.target||result.amount||result.text||result.sources.length)||result.action==='speak'&&(!result.target||!result.text.trim()||result.amount)||result.action==='transfer'&&(!result.target||!result.amount||result.text||result.sources.length))throw new Error('Invalid action');
  return result;
}
export function applyCitizenAction(db:WorldDatabase,world:WorldState,frame:ReasoningFrame,raw:unknown,id:string,origin:'local'|'network'='local'):ActionResult {
  if(!db.inTransaction)throw new Error('Citizen actions require an authoritative transaction');
  let action:CitizenAction;try{action=parseCitizenAction(raw);}catch{return {accepted:false,action:'wait',reason:'invalid_action'};}
  const reject=(reason:string):ActionResult=>({accepted:false,action:action.action,reason});
  if(action.action==='wait')return {accepted:true,action:'wait',reason:null};
  if(world.game_time_ms<frame.gameTimeMs||world.game_time_ms-frame.gameTimeMs>120000)return reject('stale_response');
  const actor=person(db,frame.citizenId);if(!actor)return reject('unknown_actor');
  const evidence=new Map(frame.sources.map(s=>[s.id,s]));if(action.sources.some(id=>!evidence.has(id)))return reject('unknown_source');
  if(action.stance==='observation'&&(!action.sources.length||action.sources.some(id=>evidence.get(id)!.kind!=='observation')))return reject('unsupported_observation');
  if(action.stance==='told'&&(!action.sources.length||action.sources.some(id=>evidence.get(id)!.kind!=='told')))return reject('unsupported_hearsay');
  if(action.action==='go') {
    const target=frame.buildings.find(b=>b.id===action.target);if(!target)return reject('unknown_building');
    if(action.goal==='work'&&actor.workplace_id!==target.id||action.goal==='sleep'&&actor.home_id!==target.id||action.goal==='eat'&&![actor.home_id,'cafe'].includes(target.id)||action.goal==='bank'&&target.id!=='bank')return reject('invalid_destination');
    const occupied=new Set((db.prepare('SELECT x,y FROM citizens WHERE id!=?').all(actor.id) as {x:number;y:number}[]).map(tileKey));const goal=entrance(target,frame.buildings,occupied,actor.id),path=goal?findPath(actor,goal,frame.buildings,occupied):null;if(path===null||!walkable(actor,frame.buildings))return reject('unreachable_destination');
    db.prepare('UPDATE citizen_routines SET goal_action=?,target_building_id=?,path=?,next_decision_game_ms=? WHERE citizen_id=?').run(action.goal,target.id,JSON.stringify(path),world.game_time_ms+5*60000,actor.id);
    db.prepare('UPDATE citizens SET thoughts=? WHERE id=?').run(`I plan to ${action.goal} at ${target.name}.`,actor.id);return {accepted:true,action:'go',reason:null};
  }
  if(action.target===actor.id||!frame.nearby.some(p=>p.id===action.target))return reject('unknown_peer');const other=person(db,action.target);
  if(!other||actor.building_id!==other.building_id||Math.abs(actor.x-other.x)+Math.abs(actor.y-other.y)>3)return reject('peer_not_nearby');
  if(actor.x!==frame.self.x||actor.y!==frame.self.y||actor.building_id!==frame.self.buildingId)return reject('actor_moved');
  if(action.action==='transfer') {
    if(actor.money<action.amount)return reject('insufficient_funds');
    try{const result=transferMoney(db,world,id,`citizen:${actor.id}`,`citizen:${other.id}`,action.amount,'transfer',actor.id,other.id);return {accepted:true,action:'transfer',reason:null,eventId:result.eventId};}catch{return reject('transfer_rejected');}
  }
  const routine=db.prepare('SELECT next_speech_game_ms FROM citizen_routines WHERE citizen_id=?').get(actor.id) as {next_speech_game_ms:number};
  if(actor.activity==='sleeping'||other.activity==='sleeping'||routine.next_speech_game_ms>world.game_time_ms)return reject('speech_cooldown');
  const witnesses=(db.prepare("SELECT id FROM citizens WHERE building_id IS ? AND ABS(x-?)+ABS(y-?)<=3 AND activity!='sleeping'").all(actor.building_id,actor.x,actor.y) as {id:string}[]).map(p=>p.id);
  const event=db.prepare("INSERT INTO events(world_version,game_time_ms,type,actor_id,target,visibility,details) VALUES(?,?,'citizen_spoke',?,?,'public',?)").run(world.version,world.game_time_ms,actor.id,other.id,JSON.stringify({text:action.text.trim(),witnessIds:witnesses}));const eventId=Number(event.lastInsertRowid);
  db.prepare('INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,source_event_id,origin,stance,source_refs) VALUES(?,?,?,?,?,?,?,?)').run(world.game_time_ms,actor.id,other.id,action.text.trim(),eventId,origin,action.stance,JSON.stringify(action.sources));
  db.prepare('UPDATE citizen_routines SET next_speech_game_ms=? WHERE citizen_id=?').run(world.game_time_ms+15*60000,actor.id);return {accepted:true,action:'speak',reason:null,eventId};
}
