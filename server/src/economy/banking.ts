import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import { balance, requireTransaction, transferMoney } from './wallets.js';
import type { Wallet } from './types.js';
import { DAY_MS } from './types.js';
export interface Debt { id:string; borrower_account:Wallet; lender_account:Wallet; outstanding:number; due_day:number; kind:string; default_reported:number }
function atBank(db:WorldDatabase,world:WorldState,citizenId:string) {
  const citizen=db.prepare('SELECT building_id,reputation FROM citizens WHERE id=?').get(citizenId) as {building_id:string;reputation:number}|undefined;
  if(!citizen||citizen.building_id!=='bank') throw new Error('Citizen must be at the bank');
  const minute=world.game_time_ms%DAY_MS/60000;
  if(minute<540||minute>=1020)throw new Error('Bank is closed');
  return citizen;
}
export function deposit(db:WorldDatabase,world:WorldState,id:string,citizenId:string,amount:number) {
  atBank(db,world,citizenId);return transferMoney(db,world,id,`citizen:${citizenId}`,`bank:${citizenId}`,amount,'deposit',citizenId,'bank');
}
export function withdraw(db:WorldDatabase,world:WorldState,id:string,citizenId:string,amount:number) {
  atBank(db,world,citizenId);return transferMoney(db,world,id,`bank:${citizenId}`,`citizen:${citizenId}`,amount,'withdrawal',citizenId,'bank');
}
export function bankLoan(db:WorldDatabase,world:WorldState,id:string,citizenId:string,amount:number):Debt {
  requireTransaction(db);
  if(!id||id.length>64)throw new Error('Loan id must contain 1–64 characters');
  return db.transaction(()=>{
    const citizen=atBank(db,world,citizenId);
    const saved=db.prepare('SELECT * FROM debts WHERE id=?').get(id) as Debt|undefined;
    if(saved) {
      if(saved.kind!=='bank_loan'||saved.borrower_account!==`citizen:${citizenId}`||saved.lender_account!=='system:bank-reserve')throw new Error('Loan id already belongs to another debt');
      transferMoney(db,world,id,'system:bank-reserve',`citizen:${citizenId}`,amount,'loan',citizenId,'bank');return saved;
    }
    const outstanding=(db.prepare("SELECT COALESCE(SUM(outstanding),0) AS n FROM debts WHERE borrower_account=? AND kind='bank_loan'").get(`citizen:${citizenId}`) as {n:number}).n;
    if(citizen.reputation<40||!Number.isSafeInteger(amount)||amount<1000||amount>50000||outstanding+amount>50000) throw new Error('Loan eligibility or limit exceeded');
    transferMoney(db,world,id,'system:bank-reserve',`citizen:${citizenId}`,amount,'loan',citizenId,'bank');
    db.prepare('INSERT INTO debts(id,borrower_account,lender_account,outstanding,due_day,kind) VALUES (?,?,?,?,?,?)')
      .run(id,`citizen:${citizenId}`,'system:bank-reserve',amount,Math.floor(world.game_time_ms/DAY_MS)+4,'bank_loan');
    return db.prepare('SELECT * FROM debts WHERE id=?').get(id) as Debt;
  })();
}
export function lendMoney(db:WorldDatabase,world:WorldState,id:string,lenderId:string,borrowerId:string,amount:number):Debt {
  requireTransaction(db);
  if(!id||id.length>64)throw new Error('Loan id must contain 1–64 characters');
  return db.transaction(()=>{
    const people=db.prepare('SELECT id,x,y,building_id FROM citizens WHERE id IN (?,?)').all(lenderId,borrowerId) as {id:string;x:number;y:number;building_id:string|null}[];
    const a=people.find((person)=>person.id===lenderId),b=people.find((person)=>person.id===borrowerId);
    if(!a||!b||lenderId===borrowerId||a.building_id!==b.building_id||Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>3) throw new Error('Loan participants must be together');
    const relation=db.prepare('SELECT trust FROM relationships WHERE citizen_id=? AND other_id=?').get(lenderId,borrowerId) as {trust:number};
    if(relation.trust<40) throw new Error('Lender does not trust the borrower');
    const saved=db.prepare('SELECT * FROM debts WHERE id=?').get(id) as Debt|undefined;
    if(saved&&(saved.kind!=='peer_loan'||saved.borrower_account!==`citizen:${borrowerId}`||saved.lender_account!==`citizen:${lenderId}`))throw new Error('Loan id already belongs to another debt');
    transferMoney(db,world,id,`citizen:${lenderId}`,`citizen:${borrowerId}`,amount,'loan',borrowerId,lenderId);
    if(saved) return saved;
    db.prepare('INSERT INTO debts(id,borrower_account,lender_account,outstanding,due_day,kind) VALUES (?,?,?,?,?,?)')
      .run(id,`citizen:${borrowerId}`,`citizen:${lenderId}`,amount,Math.floor(world.game_time_ms/DAY_MS)+4,'peer_loan');
    db.prepare('UPDATE relationships SET debt=debt+? WHERE citizen_id=? AND other_id=?').run(amount,borrowerId,lenderId);
    return db.prepare('SELECT * FROM debts WHERE id=?').get(id) as Debt;
  })();
}
export function repayDebt(db:WorldDatabase,world:WorldState,id:string,debtId:string,amount:number) {
  requireTransaction(db);
  return db.transaction(()=>{
    const debt=db.prepare('SELECT * FROM debts WHERE id=?').get(debtId) as Debt|undefined;
    if(!debt) throw new Error('Unknown debt');
    const saved=db.prepare('SELECT id FROM money_transactions WHERE id=?').get(id);
    if(!saved&&(!Number.isSafeInteger(amount)||amount<=0||amount>debt.outstanding)) throw new Error('Repayment exceeds debt');
    const borrower=debt.borrower_account.startsWith('citizen:')?debt.borrower_account.slice(8):undefined;
    if(debt.kind==='bank_loan'&&borrower) atBank(db,world,borrower);
    const result=transferMoney(db,world,id,debt.borrower_account,debt.lender_account,amount,'repayment',borrower,debt.lender_account.startsWith('citizen:')?debt.lender_account.slice(8):undefined);
    if(!saved) {
      db.prepare('UPDATE debts SET outstanding=outstanding-? WHERE id=?').run(amount,debtId);
      if(debt.kind==='peer_loan') db.prepare('UPDATE relationships SET debt=MAX(0,debt-?) WHERE citizen_id=? AND other_id=?').run(amount,borrower,debt.lender_account.slice(8));
    }
    return result;
  })();
}
export function bankAction(db:WorldDatabase,world:WorldState,citizenId:string) {
  const state=db.prepare('SELECT next_bank_visit FROM economic_state WHERE citizen_id=?').get(citizenId) as {next_bank_visit:number};
  if(state.next_bank_visit>world.game_time_ms) return;
  const cash=balance(db,`citizen:${citizenId}`),savings=balance(db,`bank:${citizenId}`);
  const debt=db.prepare("SELECT * FROM debts WHERE borrower_account=? AND kind='bank_loan' AND outstanding>0 ORDER BY due_day LIMIT 1").get(`citizen:${citizenId}`) as Debt|undefined;
  const id=`bank:${citizenId}:${world.version}`;
  if(debt&&cash>debt.outstanding+5000) repayDebt(db,world,id,debt.id,debt.outstanding);
  else if(cash<7500&&savings>0) withdraw(db,world,id,citizenId,Math.min(savings,20000));
  else if(cash<7500&&!debt) {
    const citizen=atBank(db,world,citizenId);
    if(citizen.reputation>=40&&balance(db,'system:bank-reserve')>=20000) bankLoan(db,world,id,citizenId,20000);
  } else if(cash>60000) deposit(db,world,id,citizenId,cash-60000);
  db.prepare('UPDATE economic_state SET next_bank_visit=? WHERE citizen_id=?').run(world.game_time_ms+6*3600000,citizenId);
}
