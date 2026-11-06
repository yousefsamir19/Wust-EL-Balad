import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { balance, economicEvent, transferMoney } from './wallets.js';
import { repayDebt, type Debt } from './banking.js';
import { changeEmployment } from './actions.js';
import { DAY_MS, RENT, type Business } from './types.js';
interface Worker {citizen_id:string;business_id:string;work_day:number;worked_ms:number;wage_settled:number;missed_days:number;activity:string;building_id:string|null;shift_start:number;shift_end:number}
function settleWage(db:WorldDatabase,world:WorldState,worker:Worker) {
  if(worker.wage_settled)return;
  const business=db.prepare('SELECT * FROM businesses WHERE id=?').get(worker.business_id) as Business;
  const owed=Math.round(business.wage*Math.min(1,worker.worked_ms/((worker.shift_end-worker.shift_start)*60000)));
  const paid=Math.min(owed,business.balance),remaining=owed-paid;
  if(paid>0)transferMoney(db,world,`wage:${worker.citizen_id}:${worker.work_day}`,`business:${business.id}`,`citizen:${worker.citizen_id}`,paid,'wage',worker.citizen_id,business.id);
  if(remaining>0) {
    db.prepare('INSERT OR IGNORE INTO debts(id,borrower_account,lender_account,outstanding,due_day,kind) VALUES (?,?,?,?,?,?)')
      .run(`wage-debt:${worker.citizen_id}:${worker.work_day}`,`business:${business.id}`,`citizen:${worker.citizen_id}`,remaining,worker.work_day+2,'wage_arrears');
    economicEvent(db,world,'wage_unpaid',worker.citizen_id,business.id,remaining,70,{employerId:business.owner_id});
  }
  if(!owed)economicEvent(db,world,'work_missed',worker.citizen_id,business.id,null,40,{});
  worker.missed_days=remaining>0||owed===0?worker.missed_days+1:0;worker.wage_settled=1;
  db.prepare('UPDATE employment SET wage_settled=1,missed_days=? WHERE citizen_id=?').run(worker.missed_days,worker.citizen_id);
  if(worker.missed_days>=3)changeEmployment(db,world,`job-ended:${worker.citizen_id}:${worker.work_day}`,worker.citizen_id,null);
}
export function advanceEconomy(db:WorldDatabase,world:WorldState,previous:WorldState) {
  const day=Math.floor(world.game_time_ms/DAY_MS)+1;
  const workers=db.prepare(`SELECT e.*,c.activity,c.building_id,s.shift_start,s.shift_end FROM employment e
    JOIN citizens c ON c.id=e.citizen_id JOIN schedules s ON s.citizen_id=e.citizen_id WHERE e.active=1`).all() as Worker[];
  for(const worker of workers) {
    for(let current=worker.work_day;current<=day;current++) {
      if(current!==worker.work_day) {
        worker.work_day=current;worker.worked_ms=0;worker.wage_settled=0;
        db.prepare('UPDATE employment SET work_day=?,worked_ms=0,wage_settled=0 WHERE citizen_id=?').run(current,worker.citizen_id);
      }
      const start=(current-1)*DAY_MS+worker.shift_start*60000,end=(current-1)*DAY_MS+worker.shift_end*60000;
      if(worker.activity==='working'&&worker.building_id===worker.business_id&&!worker.wage_settled) {
        worker.worked_ms+=Math.max(0,Math.min(world.game_time_ms,end)-Math.max(previous.game_time_ms,start));
        db.prepare('UPDATE employment SET worked_ms=? WHERE citizen_id=?').run(worker.worked_ms,worker.citizen_id);
      }
      if(world.game_time_ms>=end)settleWage(db,world,worker);
      const active=db.prepare('SELECT active FROM employment WHERE citizen_id=?').get(worker.citizen_id) as {active:number};
      if(!active.active)break;
    }
  }
  const previousDay=Math.floor(previous.game_time_ms/DAY_MS)+1;
  for(let current=previousDay+1;current<=day;current++) {
    if(db.prepare('SELECT day FROM economy_days WHERE day=?').get(current))continue;
    db.prepare('INSERT INTO economy_days VALUES (?)').run(current);
    const citizens=db.prepare('SELECT id,money FROM citizens ORDER BY id').all() as {id:string;money:number}[];
    for(const citizen of citizens) {
      const paid=Math.min(citizen.money,RENT);
      if(paid)transferMoney(db,world,`rent:${citizen.id}:${current-1}`,`citizen:${citizen.id}`,'system:landlord',paid,'rent',citizen.id,`home-${citizen.id}`);
      if(paid<RENT) {
        db.prepare('INSERT OR IGNORE INTO debts(id,borrower_account,lender_account,outstanding,due_day,kind) VALUES (?,?,?,?,?,?)')
          .run(`rent-debt:${citizen.id}:${current-1}`,`citizen:${citizen.id}`,'system:landlord',RENT-paid,current+1,'rent_arrears');
        economicEvent(db,world,'rent_unpaid',citizen.id,`home-${citizen.id}`,RENT-paid,70,{});
      }
    }
    const shops=db.prepare("SELECT * FROM businesses WHERE id IN ('cafe','store') AND stock<20").all() as Business[];
    for(const shop of shops) {
      const quantity=Math.min(40,Math.floor(shop.balance/500));
      if(quantity>0) {
        transferMoney(db,world,`restock:${shop.id}:${current}`,`business:${shop.id}`,'system:supplier',quantity*500,'restock',undefined,shop.id);
        db.prepare('UPDATE businesses SET stock=stock+? WHERE id=?').run(quantity,shop.id);
      }
    }
  }
  const debts=db.prepare('SELECT * FROM debts WHERE outstanding>0 ORDER BY due_day,id').all() as Debt[];
  for(const debt of debts) {
    const available=balance(db,debt.borrower_account);
    if(debt.kind!=='bank_loan'&&day>=debt.due_day&&available>0) repayDebt(db,world,`debt-auto:${debt.id}:${world.version}`,debt.id,Math.min(available,debt.outstanding));
    const remaining=(db.prepare('SELECT outstanding FROM debts WHERE id=?').get(debt.id) as {outstanding:number}).outstanding;
    if(remaining>0&&day>debt.due_day&&!debt.default_reported) {
      const actor=debt.borrower_account.startsWith('citizen:')?debt.borrower_account.slice(8):debt.lender_account.startsWith('citizen:')?debt.lender_account.slice(8):null;
      const target=debt.lender_account.startsWith('citizen:')?debt.lender_account.slice(8):debt.borrower_account.startsWith('business:')?debt.borrower_account.slice(9):'bank';
      economicEvent(db,world,'debt_overdue',actor,target,remaining,75,{debtId:debt.id,kind:debt.kind});
      db.prepare('UPDATE debts SET default_reported=1 WHERE id=?').run(debt.id);
    }
  }
}
