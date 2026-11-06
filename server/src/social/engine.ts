import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { remember,believe,compactMemories } from './memories.js';
import type { SocialEvent,Provenance } from './types.js';
interface Person {id:string;name:string;x:number;y:number;building_id:string|null;money:number;job:string;workplace_id:string|null;needs:string;mood:string}
type Scores='trust'|'affection'|'respect'|'fear'|'grudge'|'suspicion'|'dependence';
const financial=new Set(['wage_paid','wage_unpaid','purchase','loan_issued','debt_repaid','rent_paid','rent_unpaid','bank_deposit','bank_withdrawal','debt_overdue','stock_purchase','money_transferred','meal_unaffordable','work_missed','employment_started','employment_ended']);
function adjust(db:WorldDatabase,a:string,b:string,change:Partial<Record<Scores,number>>) {
  if(a===b)return;
  const row=db.prepare('SELECT * FROM relationships WHERE citizen_id=? AND other_id=?').get(a,b) as Record<Scores,number>|undefined;
  if(!row)return;
  const clamp=(value:number)=>Math.max(0,Math.min(100,value));
  db.prepare('UPDATE relationships SET trust=?,affection=?,respect=?,fear=?,grudge=?,suspicion=?,dependence=? WHERE citizen_id=? AND other_id=?')
    .run(...(['trust','affection','respect','fear','grudge','suspicion','dependence'] as Scores[]).map(k=>clamp(row[k]+(change[k]??0))),a,b);
}
function reputation(db:WorldDatabase,id:string,delta:number) {db.prepare('UPDATE citizens SET reputation=MIN(100,MAX(0,reputation+?)) WHERE id=?').run(delta,id);}
function interpret(db:WorldDatabase,event:SocialEvent,people:Map<string,Person>) {
  const a=event.actor_id,b=event.target;
  if(!a)return;
  const details=JSON.parse(event.details) as {text?:string;kind?:string};
  if(event.type==='citizen_spoke'&&b&&people.has(b)) {
    const text=details.text??'';
    const insult=/\b(?:you(?:'re| are)?).{0,35}\b(?:stupid|idiot|liar|useless)\b|\bI hate you\b|\bleave me alone\b/i.test(text);
    const guarded=/keep my personal worries to myself/i.test(text);
    if(insult) {
      adjust(db,b,a,{trust:-8,affection:-6,respect:-3,grudge:12,suspicion:5});adjust(db,a,b,{respect:-1});
      believe(db,b,`I interpreted ${people.get(a)!.name}'s words as disrespectful.`,55,event.id,a);
    } else if(guarded)adjust(db,b,a,{suspicion:1});
    else {adjust(db,b,a,{trust:2,affection:3,respect:1});adjust(db,a,b,{trust:1,affection:1});}
  }
  if(event.type==='loan_issued'&&b&&people.has(b)) {adjust(db,a,b,{trust:3,affection:2,dependence:10});adjust(db,b,a,{respect:1});}
  if(event.type==='debt_repaid'&&b&&people.has(b)) {adjust(db,b,a,{trust:8,respect:6,grudge:-5,suspicion:-4});adjust(db,a,b,{trust:2,fear:-5,dependence:-3});}
  if(event.type==='debt_overdue'&&b&&people.has(b)) {adjust(db,b,a,{trust:-12,respect:-10,grudge:15,suspicion:15});adjust(db,a,b,{fear:10,dependence:5});}
  const business=b?db.prepare('SELECT owner_id FROM businesses WHERE id=?').get(b) as {owner_id:string|null}|undefined:undefined;
  if(business?.owner_id&&business.owner_id!==a) {
    if(event.type==='wage_paid'){adjust(db,a,business.owner_id,{trust:3,respect:2,dependence:1});adjust(db,business.owner_id,a,{respect:1});}
    if(event.type==='wage_unpaid'||event.type==='debt_overdue'&&details.kind==='wage_arrears') {
      adjust(db,a,business.owner_id,{trust:-10,respect:-7,grudge:12,suspicion:8});adjust(db,business.owner_id,a,{fear:5,dependence:2});
      believe(db,a,`I am worried that ${people.get(business.owner_id)!.name} cannot reliably pay me.`,60,event.id,business.owner_id);
      if(event.visibility==='public')reputation(db,business.owner_id,-2);
    }
    if(event.type==='work_missed')adjust(db,business.owner_id,a,{trust:-4,respect:-5});
  }
  if(event.visibility==='public'&&event.type==='wage_paid')reputation(db,a,1);
  if(event.visibility==='public'&&event.type==='debt_overdue'&&details.kind!=='wage_arrears')reputation(db,a,-3);
}
function describe(event:SocialEvent,people:Map<string,Person>,buildings:Map<string,string>) {
  const a=event.actor_id?people.get(event.actor_id)?.name??'Someone':'A business';
  const target=event.target?(people.get(event.target)?.name??buildings.get(event.target)??event.target):'';
  const details=JSON.parse(event.details) as {text?:string;reason?:string};
  if(event.type==='citizen_spoke')return `${a} told ${target}: ${details.text??''}`;
  if(event.type==='citizen_arrived')return `${a} arrived at ${target}.`;
  if(event.type==='citizen_departed')return `${a} left ${target}.`;
  if(event.type==='meal_unaffordable')return `${a} could not get a meal (${details.reason??'unavailable'}).`;
  return `${a}: ${event.type.replaceAll('_',' ')}${event.amount!==null?` EGP ${(event.amount/100).toFixed(2)}`:''}${target?` involving ${target}`:''}.`;
}
export function advanceSocial(db:WorldDatabase,world:WorldState) {
  const people=new Map((db.prepare('SELECT id,name,x,y,building_id,money,job,workplace_id,needs,mood FROM citizens').all() as Person[]).map(p=>[p.id,p]));
  const buildings=new Map((db.prepare('SELECT id,name FROM buildings').all() as {id:string;name:string}[]).map(p=>[p.id,p.name]));
  const cursor=(db.prepare('SELECT last_event_id FROM social_cursor WHERE id=1').get() as {last_event_id:number}).last_event_id;
  const events=db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(cursor) as SocialEvent[];
  const affected=new Set<string>();
  for(const event of events) {
    const details=JSON.parse(event.details) as {text?:string;fromAccount?:string;toAccount?:string;witnessIds?:string[];secretId?:string};
    const witnesses=new Set<string>();
    if(event.actor_id&&people.has(event.actor_id))witnesses.add(event.actor_id);
    if(event.type==='citizen_spoke'&&event.target&&people.has(event.target))witnesses.add(event.target);
    if(financial.has(event.type)) {
      if(event.target&&people.has(event.target))witnesses.add(event.target);
      for(const account of [details.fromAccount,details.toAccount]) {
        if(account?.startsWith('citizen:')&&people.has(account.slice(8)))witnesses.add(account.slice(8));
        if(account?.startsWith('business:')) {const owner=db.prepare('SELECT owner_id FROM businesses WHERE id=?').get(account.slice(9)) as {owner_id:string|null}|undefined;if(owner?.owner_id)witnesses.add(owner.owner_id);}
      }
      const business=event.target?db.prepare('SELECT owner_id FROM businesses WHERE id=?').get(event.target) as {owner_id:string|null}|undefined:undefined;
      if(business?.owner_id)witnesses.add(business.owner_id);
    } else if(event.visibility==='public'&&event.actor_id) {
      const actor=people.get(event.actor_id);
      if(Array.isArray(details.witnessIds))details.witnessIds.filter(id=>people.has(id)).forEach(id=>witnesses.add(id));
      else if(actor)for(const person of people.values())if(person.building_id===actor.building_id&&Math.abs(person.x-actor.x)+Math.abs(person.y-actor.y)<=3)witnesses.add(person.id);
    }
    for(const id of witnesses) {
      const mode:Provenance=event.type==='citizen_spoke'&&id!==event.actor_id?'told':'observation';
      if(!db.prepare('INSERT OR IGNORE INTO observed_events VALUES(?,?,?)').run(id,event.id,mode).changes)continue;
      affected.add(id);
      let confidence=100;
      if(mode==='told'&&event.actor_id) {
        confidence=Math.min(90,(db.prepare('SELECT trust FROM relationships WHERE citizen_id=? AND other_id=?').get(id,event.actor_id) as {trust:number}).trust);
        if(details.secretId){const held=db.prepare('SELECT confidence FROM secret_knowledge WHERE secret_id=? AND citizen_id=?').get(details.secretId,event.actor_id) as {confidence:number}|undefined;confidence=held?Math.floor(confidence*held.confidence/100):0;}
      }
      remember(db,event,id,mode,describe(event,people,buildings),id===event.actor_id&&event.target&&people.has(event.target)?event.target:event.actor_id===id?null:event.actor_id,confidence);
    }
    interpret(db,event,people);
    db.prepare('UPDATE social_cursor SET last_event_id=? WHERE id=1').run(event.id);
  }
  db.prepare(`UPDATE relationships SET debt=COALESCE((SELECT SUM(d.outstanding) FROM debts d WHERE d.kind='peer_loan' AND d.borrower_account='citizen:'||relationships.citizen_id AND d.lender_account='citizen:'||relationships.other_id),0)`).run();
  const day=Math.floor(world.game_time_ms/86400000)+1;
  for(const person of people.values()) {
    const state=db.prepare('SELECT * FROM social_state WHERE citizen_id=?').get(person.id) as {last_compaction_day:number;last_decay_game_ms:number};
    const elapsed=Math.floor((world.game_time_ms-state.last_decay_game_ms)/(6*3600000));
    if(elapsed>0) {
      db.prepare("UPDATE knowledge SET confidence=CASE WHEN confidence>10 THEN MAX(10,confidence-?) ELSE confidence END WHERE citizen_id=? AND kind!='observation'").run(elapsed,person.id);
      db.prepare('UPDATE secret_knowledge SET confidence=CASE WHEN confidence>10 THEN MAX(10,confidence-?) ELSE confidence END WHERE citizen_id=? AND source_event_id IS NOT NULL').run(elapsed,person.id);
      db.prepare('UPDATE social_state SET last_decay_game_ms=? WHERE citizen_id=?').run(world.game_time_ms,person.id);
    }
    if(affected.has(person.id)||state.last_compaction_day!==day){compactMemories(db,person.id,world.game_time_ms);db.prepare('UPDATE social_state SET last_compaction_day=? WHERE citizen_id=?').run(day,person.id);}
    const needs=JSON.parse(person.needs) as {hunger:number;energy:number;social:number};
    const scores=db.prepare('SELECT MAX(fear) fear,MAX(grudge) grudge,MAX(affection) affection FROM relationships WHERE citizen_id=?').get(person.id) as {fear:number;grudge:number;affection:number};
    const owed=(db.prepare('SELECT COALESCE(SUM(outstanding),0) n FROM debts WHERE borrower_account=?').get(`citizen:${person.id}`) as {n:number}).n;
    const mood=needs.hunger>=75?'Hungry':needs.energy<=20?'Tired':owed>person.money?'Anxious':scores.grudge>=75?'Resentful':scores.fear>=65?'Wary':needs.social>=75?'Lonely':scores.affection>=70&&needs.social<=20?'Content':'Calm';
    const goals:string[]=[];
    if(needs.hunger>=60)goals.push('Find an affordable meal');if(needs.energy<=25)goals.push('Rest safely at home');if(owed>0)goals.push('Meet my financial obligations');if(!person.workplace_id)goals.push('Find steady employment');if(needs.social>=65)goals.push('Talk with someone I trust');if(scores.grudge>=65)goals.push('Resolve a difficult relationship');if(!goals.length)goals.push(`Keep improving as a ${person.job.toLowerCase()}`);
    db.prepare('UPDATE citizens SET mood=?,goals=? WHERE id=?').run(mood,JSON.stringify(goals.slice(0,3)),person.id);
  }
}
