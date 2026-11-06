import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openWorld,type WorldDatabase } from '../server/src/db/index.js';
import { SimulationClock,type WorldState } from '../server/src/simulation/clock.js';
import { balance,transferMoney } from '../server/src/economy/wallets.js';
import { bankLoan,deposit,withdraw,lendMoney,repayDebt } from '../server/src/economy/banking.js';
import { changeEmployment,economicArrival } from '../server/src/economy/actions.js';
import { DAY_MS,MEAL_PRICE,RENT } from '../server/src/economy/types.js';
function setup() {
  const db=openWorld(':memory:');db.prepare('UPDATE world SET game_time_ms=?').run(9*3600000);
  const clock=new SimulationClock(db);
  return {db,clock,act:<T>(id:string,fn:(db:WorldDatabase,w:WorldState)=>T)=>clock.commitCommand(id,(d,w)=>fn(d,{...w,version:w.version+1})),close:()=>{clock.stop();db.close();}};
}
function total(db:WorldDatabase) {return (db.prepare(`SELECT SUM(n) AS n FROM (SELECT money n FROM citizens UNION ALL SELECT balance FROM businesses UNION ALL SELECT balance FROM bank_accounts UNION ALL SELECT balance FROM system_wallets)`).get() as {n:number}).n;}
const count=(db:WorldDatabase,sql:string)=>(db.prepare(sql).get() as {n:number}).n;
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('wallet transfers conserve money, validate resources, reject ID misuse, and roll back caught failures',()=>{
  const {db,clock,act,close}=setup();try {
    const sum=total(db),before=balance(db,'citizen:karim');
    assert.throws(()=>transferMoney(db,clock.state(),'outside','citizen:karim','citizen:laila',100,'transfer'),/transaction/);
    const transfer=(d:WorldDatabase,w:WorldState)=>transferMoney(d,w,'payment','citizen:karim','citizen:laila',1000,'transfer');
    act('pay',transfer);act('pay-retry',transfer);
    assert.equal(balance(db,'citizen:karim'),before-1000);assert.equal(total(db),sum);
    assert.equal(count(db,"SELECT COUNT(*) n FROM money_transactions WHERE id='payment'"),1);
    for(const amount of [0,-1,NaN,Number.MAX_SAFE_INTEGER])assert.throws(()=>act(`invalid-${amount}`,(d,w)=>transferMoney(d,w,`invalid-${amount}`,'citizen:karim','citizen:laila',amount,'transfer')));
    assert.throws(()=>act('misuse',(d,w)=>transferMoney(d,w,'payment','citizen:karim','citizen:laila',2000,'transfer')),/different contents/);
    act('caught',(d,w)=>{assert.throws(()=>transferMoney(d,w,'caught','citizen:karim','citizen:missing',100,'transfer'));return true;});
    const saved=balance(db,'citizen:karim');assert.throws(()=>act('rollback',(d,w)=>{transferMoney(d,w,'rollback','citizen:karim','citizen:laila',100,'transfer');throw new Error('interrupt');}));
    assert.equal(balance(db,'citizen:karim'),saved);assert.equal(total(db),sum);
  }finally{close();}
});

test('bank accounts, capped lending, repayments, opening hours, and retries preserve balances',()=>{
  const {db,clock,act,close}=setup();try {
    db.prepare("UPDATE citizens SET building_id='bank' WHERE id='karim'").run();const sum=total(db);
    act('deposit',(d,w)=>deposit(d,w,'deposit','karim',10000));assert.equal(balance(db,'bank:karim'),10000);
    assert.throws(()=>act('overdraw',(d,w)=>withdraw(d,w,'overdraw','karim',20000)));
    act('withdraw',(d,w)=>withdraw(d,w,'withdraw','karim',2000));
    act('loan',(d,w)=>bankLoan(d,w,'loan','karim',20000));act('loan-retry',(d,w)=>bankLoan(d,w,'loan','karim',20000));
    assert.throws(()=>act('limit',(d,w)=>bankLoan(d,w,'limit','karim',40000)),/limit/);
    act('repay',(d,w)=>repayDebt(d,w,'repay','loan',5000));act('repay-retry',(d,w)=>repayDebt(d,w,'repay','loan',5000));
    assert.equal(count(db,"SELECT outstanding n FROM debts WHERE id='loan'"),15000);assert.equal(total(db),sum);
    db.prepare('UPDATE world SET game_time_ms=?').run(18*3600000);assert.throws(()=>act('closed',(d,w)=>deposit(d,w,'closed','karim',100)),/closed/);
    act('late-arrival',(d,w)=>{d.prepare("UPDATE citizens SET activity='banking' WHERE id='karim'").run();economicArrival(d,w,'karim');return true;});
    assert.equal((db.prepare("SELECT activity FROM citizens WHERE id='karim'").get() as {activity:string}).activity,'idle');
    assert.ok(clock.step(1000).tick>0);
  }finally{close();}
});

test('peer loans are local, trusted, auditable obligations and repayment changes directed debt once',()=>{
  const {db,act,close}=setup();try {
    db.prepare("UPDATE citizens SET building_id='square',x=52,y=38 WHERE id IN ('karim','laila')").run();
    db.prepare("UPDATE relationships SET trust=80 WHERE citizen_id='karim' AND other_id='laila'").run();const sum=total(db);
    act('peer',(d,w)=>lendMoney(d,w,'peer','karim','laila',2000));act('peer-retry',(d,w)=>lendMoney(d,w,'peer','karim','laila',2000));
    assert.equal(count(db,"SELECT debt n FROM relationships WHERE citizen_id='laila' AND other_id='karim'"),2000);
    act('peer-pay',(d,w)=>repayDebt(d,w,'peer-pay','peer',800));act('peer-pay-retry',(d,w)=>repayDebt(d,w,'peer-pay','peer',800));
    assert.equal(count(db,"SELECT debt n FROM relationships WHERE citizen_id='laila' AND other_id='karim'"),2000-800);assert.equal(total(db),sum);
    db.prepare("UPDATE citizens SET x=1 WHERE id='laila'").run();assert.throws(()=>act('distant',(d,w)=>lendMoney(d,w,'distant','karim','laila',100)),/together/);
  }finally{close();}
});

test('unaffordable meals never restore hunger; a paid meal consumes cash and stock only once',()=>{
  const {db,clock,close}=setup();try {
    db.prepare("UPDATE citizens SET money=0,building_id='cafe',x=12,y=16,activity='eating',needs=? WHERE id='karim'").run(JSON.stringify({hunger:80,energy:80,social:20}));
    db.prepare("UPDATE economic_state SET pantry=0 WHERE citizen_id='karim'").run();
    db.prepare("UPDATE citizen_routines SET goal_action='eat',target_building_id='cafe',path='[]',next_decision_game_ms=? WHERE citizen_id='karim'").run(DAY_MS);
    clock.step(1000);const starved=JSON.parse((db.prepare("SELECT needs FROM citizens WHERE id='karim'").get() as {needs:string}).needs).hunger;
    assert.ok(starved>=80);assert.equal(balance(db,'citizen:karim'),0);
    db.prepare("UPDATE citizens SET money=3000 WHERE id='karim'").run();const sum=total(db),stock=count(db,"SELECT stock n FROM businesses WHERE id='cafe'");
    clock.step(1000);clock.step(1000);
    assert.ok(JSON.parse((db.prepare("SELECT needs FROM citizens WHERE id='karim'").get() as {needs:string}).needs).hunger<starved);
    assert.equal(balance(db,'citizen:karim'),3000-MEAL_PRICE);assert.equal(count(db,"SELECT stock n FROM businesses WHERE id='cafe'"),stock-1);assert.equal(total(db),sum);
    assert.equal(count(db,"SELECT COUNT(*) n FROM money_transactions WHERE from_id='karim' AND type='purchase'"),1);
  }finally{close();}
});

test('attendance wages and daily rent are paid once, including after clock restart',()=>{
  const {db,clock,close}=setup();let second:SimulationClock|undefined;try {
    db.prepare('UPDATE world SET game_time_ms=?').run(8*3600000);
    db.prepare("UPDATE citizens SET activity='working',building_id='mechanic',x=33,y=38 WHERE id='karim'").run();const sum=total(db);
    clock.step(9*3600000/4);clock.step(1000);
    assert.equal(count(db,"SELECT amount n FROM money_transactions WHERE id='wage:karim:1'"),count(db,"SELECT wage n FROM businesses WHERE id='mechanic'"));
    clock.step((DAY_MS-clock.state().game_time_ms+4)/4);
    assert.equal(count(db,"SELECT amount n FROM money_transactions WHERE id='rent:karim:1'"),RENT);assert.equal(total(db),sum);
    const rents=count(db,"SELECT COUNT(*) n FROM money_transactions WHERE type='rent'");clock.stop();second=new SimulationClock(db);second.step(1000);
    assert.equal(count(db,"SELECT COUNT(*) n FROM money_transactions WHERE type='rent'"),rents);
  }finally{second?.stop();close();}
});

test('unfunded wages create arrears and general job loss rather than minting money',()=>{
  const {db,clock,close}=setup();try {
    db.prepare("UPDATE businesses SET balance=0 WHERE id='mechanic'").run();
    db.prepare("UPDATE citizens SET money=0 WHERE id='karim'").run();
    for(let day=1;day<=3;day++) {
      db.prepare('UPDATE world SET game_time_ms=?').run((day-1)*DAY_MS+8*3600000);
      db.prepare("UPDATE citizens SET activity='working',building_id='mechanic',x=33,y=38 WHERE id='karim'").run();
      clock.step(9*3600000/4);
    }
    assert.equal((db.prepare("SELECT workplace_id FROM citizens WHERE id='karim'").get() as {workplace_id:string|null}).workplace_id,null);
    assert.equal(count(db,"SELECT COUNT(*) n FROM debts WHERE lender_account='citizen:karim' AND kind='wage_arrears'"),3);
    assert.equal(balance(db,'business:mechanic'),0);assert.equal(count(db,"SELECT COUNT(*) n FROM money_transactions WHERE to_id='karim' AND type='wage'"),0);
  }finally{close();}
});

test('employment requires a funded local vacancy and cannot overfill a business',()=>{
  const {db,act,close}=setup();try {
    assert.throws(()=>act('remote-hire',(d,w)=>changeEmployment(d,w,'remote-hire','karim','bank')),/in person/);
    db.prepare("UPDATE citizens SET building_id='bank' WHERE id IN ('karim','mostafa')").run();
    act('hire',(d,w)=>changeEmployment(d,w,'hire','karim','bank'));act('hire-retry',(d,w)=>changeEmployment(d,w,'hire','karim','bank'));
    assert.equal(count(db,"SELECT COUNT(*) n FROM employment WHERE active=1 AND business_id='bank'"),3);
    assert.throws(()=>act('full-hire',(d,w)=>changeEmployment(d,w,'full-hire','mostafa','bank')),/vacancy/);
  }finally{close();}
});

test('running production meal purchases, read-only statements, and debt/money persistence survive restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'wust-economy-')),file=join(directory,'world.db'),base='http://127.0.0.1:3016';
  const fixture=openWorld(file);fixture.prepare("UPDATE citizens SET money=10000,building_id='cafe',x=12,y=16,activity='eating',needs=? WHERE id='karim'").run(JSON.stringify({hunger:80,energy:80,social:20}));
  fixture.prepare("UPDATE citizen_routines SET goal_action='eat',target_building_id='cafe',next_decision_game_ms=? WHERE citizen_id='karim'").run(DAY_MS);
  fixture.prepare('UPDATE world SET game_time_ms=?').run(9*3600000);fixture.prepare("UPDATE citizens SET building_id='bank' WHERE id='omar'").run();
  const fixtureClock=new SimulationClock(fixture);fixtureClock.commitCommand('persistent-loan',(d,w)=>bankLoan(d,{...w,version:w.version+1},'persistent-loan','omar',5000));fixtureClock.stop();fixture.close();
  let child:ReturnType<typeof spawn>|undefined,cookie='';
  async function start(){child=spawn(process.execPath,['dist/server/server/src/index.js'],{env:{...process.env,PORT:'3016',DATABASE_URL:`file:${file}`,SIMULATION_TICK_MS:'1000',DAY_DURATION_HOURS:'6'},stdio:['ignore','pipe','pipe']});let output='';child.stderr?.on('data',data=>{output+=data;});for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(`${base}/api/health`)).ok)return;}catch{/*startup*/}await wait(50);}throw new Error('startup timeout');}
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child!.once('exit',r));}}
  try {
    await start();assert.equal((await fetch(`${base}/api/economy/karim`)).status,401);
    const signup=await fetch(`${base}/api/auth/signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'LiveEconomy',password:'test-passphrase-1234',confirmPassword:'test-passphrase-1234'})});assert.equal(signup.status,201);cookie=signup.headers.get('set-cookie')!.split(';')[0];
    let statement: {citizen:{money:number};transactions:{id:string;type:string}[]} | undefined;
    for(let i=0;i<50;i++){statement=await(await fetch(`${base}/api/economy/karim`,{headers:{Cookie:cookie}})).json();if(statement!.transactions.some(t=>t.type==='purchase'))break;await wait(50);}
    assert.equal(statement!.citizen.money,10000-MEAL_PRICE);assert.equal(statement!.transactions.filter(t=>t.type==='purchase').length,1);
    assert.equal((await fetch(`${base}/api/economy/karim`,{method:'POST',headers:{Cookie:cookie}})).status,404);
    await stop();await wait(100);await start();await wait(1100);
    const resumed=await(await fetch(`${base}/api/economy/karim`,{headers:{Cookie:cookie}})).json();assert.equal(resumed.citizen.money,statement!.citizen.money);assert.deepEqual(resumed.transactions.map((t:{id:string})=>t.id),statement!.transactions.map(t=>t.id));
    const loan=await(await fetch(`${base}/api/economy/omar`,{headers:{Cookie:cookie}})).json();assert.equal(loan.debts[0].outstanding,5000);
    await stop();
    const db=openWorld(file);assert.equal((db.pragma('integrity_check') as {integrity_check:string}[])[0].integrity_check,'ok');db.close();
  }finally{await stop();rmSync(directory,{recursive:true,force:true});}
});
