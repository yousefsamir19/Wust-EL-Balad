import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { balance, economicEvent, requireTransaction, transferMoney } from './wallets.js';
import { bankAction } from './banking.js';
import { DAY_MS, MEAL_PRICE, type Business } from './types.js';
interface Person {id:string;money:number;home_id:string;building_id:string|null;x:number;y:number;workplace_id:string|null}
const hours=(id:string)=>({start:id==='cafe'?420:id==='bank'||id==='police'?540:480,end:id==='cafe'?900:id==='store'?1080:1020});
export function changeEmployment(db:WorldDatabase,world:WorldState,id:string,citizenId:string,businessId:string|null) {
  requireTransaction(db);
  return db.transaction(()=>{
    const saved=db.prepare('SELECT * FROM employment_changes WHERE id=?').get(id) as {citizen_id:string;business_id:string|null;event_id:number}|undefined;
    if(saved) {if(saved.citizen_id!==citizenId||saved.business_id!==businessId)throw new Error('Employment id reused');return saved.event_id;}
    const citizen=db.prepare('SELECT * FROM citizens WHERE id=?').get(citizenId) as Person|undefined;
    if(!citizen)throw new Error('Unknown citizen');
    let job='Unemployed';
    if(businessId) {
      const business=db.prepare('SELECT * FROM businesses WHERE id=?').get(businessId) as Business|undefined;
      if(!business||citizen.building_id!==businessId)throw new Error('Citizen must meet an employer in person');
      const minute=world.game_time_ms%DAY_MS/60000,window=hours(businessId);
      if(minute<window.start||minute>=window.end)throw new Error('Employer is closed');
      const count=(db.prepare('SELECT COUNT(*) AS n FROM employment WHERE active=1 AND business_id=? AND citizen_id!=?').get(businessId,citizenId) as {n:number}).n;
      if(count>=business.capacity||business.balance<business.wage*2)throw new Error('No funded vacancy');
      job=business.job_title;
    }
    const day=Math.floor(world.game_time_ms/DAY_MS)+1;
    db.prepare('UPDATE employment SET business_id=?,active=?,work_day=?,worked_ms=0,wage_settled=0,missed_days=0 WHERE citizen_id=?').run(businessId,businessId?1:0,day,citizenId);
    db.prepare('UPDATE citizens SET workplace_id=?,job=?,activity=? WHERE id=?').run(businessId,job,businessId?'working':'job_seeking',citizenId);
    if(businessId)db.prepare('UPDATE schedules SET shift_start=?,shift_end=? WHERE citizen_id=?').run(businessId==='cafe'?420:businessId==='bank'||businessId==='police'?540:480,businessId==='cafe'?900:businessId==='store'?1080:1020,citizenId);
    db.prepare('UPDATE citizen_routines SET target_building_id=NULL,path=\'[]\',next_decision_game_ms=0 WHERE citizen_id=?').run(citizenId);
    const event=economicEvent(db,world,businessId?'employment_started':'employment_ended',citizenId,businessId,null,70,{job});
    db.prepare('INSERT INTO employment_changes VALUES (?,?,?,?)').run(id,citizenId,businessId,event);
    return event;
  })();
}
export function consumeMeal(db:WorldDatabase,world:WorldState,citizen:Pick<Person,'id'|'building_id'|'home_id'>) {
  requireTransaction(db);
  const state=db.prepare('SELECT pantry,meal_until,next_food_attempt FROM economic_state WHERE citizen_id=?').get(citizen.id) as {pantry:number;meal_until:number;next_food_attempt:number};
  if(state.meal_until>world.game_time_ms) return true;
  if(citizen.building_id===citizen.home_id&&state.pantry>0) {
    db.prepare('UPDATE economic_state SET pantry=pantry-1,meal_until=? WHERE citizen_id=?').run(world.game_time_ms+30*60000,citizen.id);return true;
  }
  const store=citizen.building_id==='store',cafe=citizen.building_id==='cafe';
  const minute=world.game_time_ms%DAY_MS/60000;
  const seller=store?'store':'cafe';
  const business=db.prepare('SELECT * FROM businesses WHERE id=?').get(seller) as Business;
  const open=store?minute>=480&&minute<1200:minute>=420&&minute<1260;
  const cash=balance(db,`citizen:${citizen.id}`);
  if((!store&&!cafe)||!open||business.stock<1||cash<MEAL_PRICE) {
    if(state.next_food_attempt<=world.game_time_ms) {
      economicEvent(db,world,'meal_unaffordable',citizen.id,citizen.building_id,MEAL_PRICE,60,{reason:!open?'closed':business.stock<1?'out_of_stock':'insufficient_cash'});
      db.prepare('UPDATE economic_state SET next_food_attempt=? WHERE citizen_id=?').run(world.game_time_ms+3600000,citizen.id);
    }
    return false;
  }
  transferMoney(db,world,`meal:${citizen.id}:${world.version}`,`citizen:${citizen.id}`,`business:${seller}`,MEAL_PRICE,'purchase',citizen.id,seller);
  db.prepare('UPDATE businesses SET stock=stock-1 WHERE id=?').run(seller);
  db.prepare('UPDATE economic_state SET meal_until=?,pantry=pantry+? WHERE citizen_id=?').run(world.game_time_ms+30*60000,store?1:0,citizen.id);
  return true;
}
export function economicChoice(db:WorldDatabase,world:WorldState,citizen:Person,choice:{action:string;targetId:string;score:number}) {
  const minute=world.game_time_ms%DAY_MS/60000;
  const state=db.prepare('SELECT * FROM economic_state WHERE citizen_id=?').get(citizen.id) as {pantry:number;next_bank_visit:number};
  const savings=balance(db,`bank:${citizen.id}`);
  const due=db.prepare("SELECT outstanding FROM debts WHERE borrower_account=? AND kind='bank_loan' AND outstanding>0 AND due_day<=? LIMIT 1").get(`citizen:${citizen.id}`,Math.floor(world.game_time_ms/DAY_MS)+1) as {outstanding:number}|undefined;
  if(state.next_bank_visit<=world.game_time_ms&&minute>=540&&minute<1020&&((due&&citizen.money>due.outstanding+5000)||(citizen.money<7500&&(savings>0||citizen.money<MEAL_PRICE&&state.pantry===0))||citizen.money>60000&&choice.action==='idle')) return {action:'bank',targetId:'bank',score:80};
  if(choice.action==='eat') {
    const cafe=db.prepare("SELECT stock FROM businesses WHERE id='cafe'").get() as {stock:number};
    const store=db.prepare("SELECT stock FROM businesses WHERE id='store'").get() as {stock:number};
    const open=minute>=420&&minute<1260&&cafe.stock>0;
    return {...choice,targetId:state.pantry>0&&(citizen.money<MEAL_PRICE||!open)?citizen.home_id:open?'cafe':minute>=480&&minute<1200&&store.stock>0?'store':citizen.home_id};
  }
  if(!citizen.workplace_id&&(choice.action==='idle'||choice.action==='socialize')) {
    const vacancy=db.prepare(`SELECT b.id,p.x,p.y FROM businesses b JOIN buildings p ON p.id=b.id
      WHERE b.balance>=b.wage*2 AND (SELECT COUNT(*) FROM employment e WHERE e.business_id=b.id AND e.active=1)<b.capacity`).all() as {id:string;x:number;y:number}[];
    for(let index=vacancy.length-1;index>=0;index--){const window=hours(vacancy[index].id);if(minute<window.start||minute>=window.end)vacancy.splice(index,1);}
    vacancy.sort((a,b)=>Math.abs(a.x-citizen.x)+Math.abs(a.y-citizen.y)-Math.abs(b.x-citizen.x)-Math.abs(b.y-citizen.y));
    if(vacancy.length) return {action:'work',targetId:vacancy[0].id,score:70};
  }
  return choice;
}
export function economicArrival(db:WorldDatabase,world:WorldState,citizenId:string) {
  const citizen=db.prepare('SELECT * FROM citizens WHERE id=?').get(citizenId) as Person&{activity:string};
  const minute=world.game_time_ms%DAY_MS/60000;
  if(citizen.activity==='banking'&&citizen.building_id==='bank') {
    if(minute>=540&&minute<1020)bankAction(db,world,citizenId);
    else {db.prepare("UPDATE citizens SET activity='idle' WHERE id=?").run(citizenId);db.prepare('UPDATE citizen_routines SET next_decision_game_ms=0 WHERE citizen_id=?').run(citizenId);}
  }
  if(citizen.activity==='job_seeking'&&citizen.building_id) {
    const business=db.prepare('SELECT * FROM businesses WHERE id=?').get(citizen.building_id) as Business|undefined;
    const filled=business?(db.prepare('SELECT COUNT(*) AS n FROM employment WHERE active=1 AND business_id=?').get(business.id) as {n:number}).n:0;
    const window=business?hours(business.id):null;
    if(business&&window&&minute>=window.start&&minute<window.end&&filled<business.capacity&&business.balance>=business.wage*2)changeEmployment(db,world,`hire:${citizenId}:${world.version}`,citizenId,business.id);
  }
}
