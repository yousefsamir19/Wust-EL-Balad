import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openWorld,type WorldDatabase } from '../server/src/db/index.js';
import { SimulationClock,type WorldState } from '../server/src/simulation/clock.js';
import { citizenContext,publicSocial } from '../server/src/social/context.js';
import { believe,compactMemories } from '../server/src/social/memories.js';
import { shareSecret } from '../server/src/social/secrets.js';
import { balance,transferMoney } from '../server/src/economy/wallets.js';
import { bankLoan } from '../server/src/economy/banking.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const count=(db:WorldDatabase,sql:string,...params:(string|number)[]) => (db.prepare(sql).get(...params) as {n:number}).n;
function setup(file=':memory:') {
  const db=openWorld(file);db.prepare('UPDATE world SET game_time_ms=?').run(9*3600000);const clock=new SimulationClock(db);
  return {db,clock,act:<T>(id:string,fn:(db:WorldDatabase,w:WorldState)=>T)=>clock.commitCommand(id,(d,w)=>fn(d,{...w,version:w.version+1})),close:()=>{clock.stop();db.close();}};
}
function emit(db:WorldDatabase,w:WorldState,type:string,actor:string,target:string|null,text='',visibility='public',importance=0,extra:Record<string,unknown>={}) {
  const id=Number(db.prepare('INSERT INTO events(world_version,game_time_ms,type,actor_id,target,visibility,importance,details) VALUES(?,?,?,?,?,?,?,?)').run(w.version,w.game_time_ms,type,actor,target,visibility,importance,JSON.stringify({text,...extra})).lastInsertRowid);
  if(type==='citizen_spoke'&&target)db.prepare('INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,visibility,source_event_id) VALUES(?,?,?,?,?,?)').run(w.game_time_ms,actor,target,text,visibility,id);
  return id;
}
function together(db:WorldDatabase) {db.prepare("UPDATE citizens SET building_id='square',x=52,y=38 WHERE id IN ('karim','laila')").run();}

test('perception records frozen witnesses and never tells an unaware victim the actor of a hidden action',()=>{
  const {db,act,close}=setup();try {
    db.prepare("UPDATE citizens SET building_id='square',x=52,y=38 WHERE id='karim'").run();
    const seen=act('arrival',(d,w)=>emit(d,w,'citizen_arrived','karim','square','','public',0,{witnessIds:['karim','laila']}));
    assert.equal(count(db,'SELECT COUNT(*) n FROM observed_events WHERE citizen_id=? AND event_id=?','laila',seen),1);
    assert.equal(count(db,'SELECT COUNT(*) n FROM observed_events WHERE citizen_id=? AND event_id=?','omar',seen),0);
    const hidden=act('hidden',(d,w)=>emit(d,w,'theft_committed','karim','laila','','private',90,{witnessIds:['laila','omar']}));
    assert.equal(count(db,'SELECT COUNT(*) n FROM observed_events WHERE citizen_id=? AND event_id=?','karim',hidden),1);
    assert.equal(count(db,'SELECT COUNT(*) n FROM observed_events WHERE citizen_id=? AND event_id=?','laila',hidden),0);
    assert.ok(!JSON.stringify(citizenContext(db,'laila')).includes('theft'));
    assert.ok(!JSON.stringify(publicSocial(db,'karim')).includes('theft'));
    assert.throws(()=>act('invented',(d)=>{believe(d,'omar','I witnessed the hidden theft',100,hidden,'karim');return true;}),/authoriz|observ/i);
  }finally{close();}
});

test('heard false claims remain uncertain knowledge; asymmetric reactions and command replay do not alter ground truth',()=>{
  const {db,act,close}=setup();try {
    together(db);const beforeA=count(db,"SELECT trust n FROM relationships WHERE citizen_id='karim' AND other_id='laila'"),beforeB=count(db,"SELECT trust n FROM relationships WHERE citizen_id='laila' AND other_id='karim'");
    const action=(d:WorldDatabase,w:WorldState)=>emit(d,w,'citizen_spoke','karim','laila','I think Omar took the missing cash.');
    const id=act('claim',action);const memories=count(db,'SELECT COUNT(*) n FROM memories');act('claim',action);
    assert.equal(count(db,'SELECT COUNT(*) n FROM memories'),memories);
    assert.equal(count(db,"SELECT trust n FROM relationships WHERE citizen_id='karim' AND other_id='laila'"),beforeA+1);
    assert.equal(count(db,"SELECT trust n FROM relationships WHERE citizen_id='laila' AND other_id='karim'"),beforeB+2);
    const knowledge=db.prepare("SELECT * FROM knowledge WHERE citizen_id='laila' AND source_event_id=?").get(id) as {kind:string;confidence:number;claim:string};
    assert.equal(knowledge.kind,'told');assert.ok(knowledge.confidence<=90);assert.match(knowledge.claim,/Omar/);
    assert.equal(count(db,"SELECT COUNT(*) n FROM events WHERE type='theft_committed'"),0);
    assert.equal(count(db,"SELECT COUNT(*) n FROM secret_knowledge WHERE citizen_id='laila' AND secret_id='secret-omar'"),0);
    const trust=count(db,"SELECT trust n FROM relationships WHERE citizen_id='laila' AND other_id='karim'");
    act('insult',(d,w)=>emit(d,w,'citizen_spoke','karim','laila','You are an idiot.'));
    assert.ok(count(db,"SELECT trust n FROM relationships WHERE citizen_id='laila' AND other_id='karim'")<trust);
    assert.ok(count(db,"SELECT grudge n FROM relationships WHERE citizen_id='laila' AND other_id='karim'")>0);
    assert.equal(count(db,"SELECT COUNT(*) n FROM conversations WHERE speaker_id='karim' OR recipient_id='karim'"),2);
    assert.equal(count(db,"SELECT COUNT(*) n FROM conversations WHERE speaker_id='laila' OR recipient_id='laila'"),2);
  }finally{close();}
});

test('secret sharing requires actual knowledge and keeps truth status, private dialogue, and provenance separate',()=>{
  const {db,act,close}=setup();try {
    together(db);assert.throws(()=>act('unknown-secret',(d,w)=>shareSecret(d,w,'karim','laila','secret-omar')),/cannot transmit/);
    db.prepare("INSERT INTO secrets(id,owner_id,claim,truth_status) VALUES('false-concern','karim','PRIVATE FALSE CLAIM MARKER','false')").run();
    db.prepare("INSERT INTO secret_knowledge(secret_id,citizen_id,confidence) VALUES('false-concern','karim',80)").run();
    const event=act('share',(d,w)=>shareSecret(d,w,'karim','laila','false-concern'));
    const own=citizenContext(db,'laila');assert.ok(JSON.stringify(own).includes('PRIVATE FALSE CLAIM MARKER'));
    const learned=db.prepare("SELECT * FROM secret_knowledge WHERE secret_id='false-concern' AND citizen_id='laila'").get() as {confidence:number;source_event_id:number;source_citizen_id:string};
    assert.equal(learned.source_event_id,event);assert.equal(learned.source_citizen_id,'karim');assert.ok(learned.confidence<=80);
    assert.equal((db.prepare("SELECT truth_status FROM secrets WHERE id='false-concern'").get() as {truth_status:string}).truth_status,'false');
    assert.ok(!JSON.stringify(citizenContext(db,'omar')).includes('PRIVATE FALSE CLAIM MARKER'));
    assert.ok(!JSON.stringify(publicSocial(db,'laila')).includes('false-concern'));assert.ok(!JSON.stringify(publicSocial(db,'laila')).includes('PRIVATE FALSE CLAIM MARKER'));
    assert.ok(JSON.parse((db.prepare("SELECT secrets_known FROM relationships WHERE citizen_id='laila' AND other_id='karim'").get() as {secrets_known:string}).secrets_known).includes('false-concern'));
    assert.equal(count(db,'SELECT COUNT(*) n FROM conversations WHERE source_event_id=?',event),1);
  }finally{close();}
});

test('layer caps and truthful source summaries keep AI context bounded without deleting canonical dialogue',()=>{
  const {db,act,close}=setup();try {
    together(db);
    act('many-short',(d,w)=>{for(let i=0;i<80;i++)emit(d,w,'citizen_spoke','karim','laila',`Public remark ${i}.`);return true;});
    assert.ok(count(db,"SELECT COUNT(*) n FROM memories WHERE citizen_id='laila' AND provenance='summary'")>0);
    const sources=db.prepare("SELECT memory_id,COUNT(*) n FROM memory_sources GROUP BY memory_id").all() as {n:number}[];assert.ok(sources.every(row=>row.n<=12));
    act('many-important',(d,w)=>{for(let i=0;i<60;i++)emit(d,w,'citizen_spoke','karim','laila',`Important public remark ${i}.`,'public',80);return true;});
    const caps:Record<string,number>={short_term:24,episodic:32,relationship:24,belief:32,long_term:16};
    for(const [layer,cap] of Object.entries(caps))assert.ok(count(db,'SELECT COUNT(*) n FROM memories WHERE citizen_id=? AND layer=?','laila',layer)<=cap);
    assert.ok(count(db,"SELECT COUNT(*) n FROM knowledge WHERE citizen_id='laila'")<=48);
    const context=citizenContext(db,'laila');assert.ok((context.memories as unknown[]).length<=20);assert.ok((context.conversations as unknown[]).length<=6);assert.ok((context.knowledge as unknown[]).length<=6);assert.ok((context.relationships as unknown[]).length<=6);
    assert.equal(count(db,'SELECT COUNT(*) n FROM conversations'),140);
    act('compact-again',(d,w)=>{compactMemories(d,'laila',w.game_time_ms);return true;});assert.equal(count(db,'SELECT COUNT(*) n FROM conversations'),140);
    assert.ok(!JSON.stringify(context).includes('truth_status'));
  }finally{close();}
});

test('zero-confidence claims never become more certain during decay, and financial pressure changes private mood/goals',()=>{
  const {db,clock,act,close}=setup();try {
    together(db);db.prepare("UPDATE relationships SET trust=0 WHERE citizen_id='laila' AND other_id='karim'").run();
    const source=act('skeptical',(d,w)=>emit(d,w,'citizen_spoke','karim','laila','UNTRUSTED CLAIM MARKER'));
    clock.step(6*3600000/4);assert.equal(count(db,"SELECT confidence n FROM knowledge WHERE citizen_id='laila' AND source_event_id=? AND kind='told'",source),0);
    db.prepare('UPDATE world SET game_time_ms=?').run(9*3600000);db.prepare("UPDATE citizens SET building_id='bank' WHERE id='karim'").run();
    act('pressure-loan',(d,w)=>bankLoan(d,w,'pressure-loan','karim',20000));
    act('cash-spent',(d,w)=>transferMoney(d,w,'cash-spent','citizen:karim','business:cafe',balance(d,'citizen:karim')-1000,'transfer'));
    const context=citizenContext(db,'karim');assert.equal(context.mood,'Anxious');assert.ok(JSON.stringify(context.goals).includes('financial obligations'));
  }finally{close();}
});

test('memory and social consequences roll back with an interrupted authoritative command',()=>{
  const {db,clock,act,close}=setup();try {
    together(db);const state=clock.state(),memories=count(db,'SELECT COUNT(*) n FROM memories');
    assert.throws(()=>act('interrupted',(d,w)=>{emit(d,w,'citizen_spoke','karim','laila','An interrupted statement');throw new Error('rollback');}));
    assert.deepEqual(clock.state(),state);assert.equal(count(db,'SELECT COUNT(*) n FROM memories'),memories);assert.equal(count(db,"SELECT COUNT(*) n FROM conversations WHERE text='An interrupted statement'"),0);
  }finally{close();}
});

test('restarting preserves private knowledge, directed scores, full dialogue, and bounded AI memory',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-social-')),file=join(dir,'world.db');const first=setup(file);
  together(first.db);first.act('persist',(d,w)=>shareSecret(d,w,'karim','laila','secret-karim'));const context=citizenContext(first.db,'laila'),social=publicSocial(first.db,'laila');first.close();
  try{const db=openWorld(file);assert.deepEqual(citizenContext(db,'laila'),context);assert.deepEqual(publicSocial(db,'laila'),social);assert.equal(count(db,'SELECT COUNT(*) n FROM conversations'),1);db.close();}finally{rmSync(dir,{recursive:true,force:true});}
});

test('production public social API and live memory updates work without exposing the private context',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-social-live-')),file=join(dir,'world.db'),base='http://127.0.0.1:3017';const fixture=openWorld(file);
  together(fixture);fixture.prepare("UPDATE citizens SET activity='socializing',needs=? WHERE id IN ('karim','laila')").run(JSON.stringify({hunger:20,energy:80,social:95}));fixture.prepare("UPDATE citizen_routines SET goal_action='socialize',target_building_id='square',next_decision_game_ms=0,next_speech_game_ms=0 WHERE citizen_id IN ('karim','laila')").run();fixture.close();
  const child=spawn(process.execPath,['dist/server/server/src/index.js'],{env:{...process.env,PORT:'3017',DATABASE_URL:`file:${file}`,SIMULATION_TICK_MS:'1000'},stdio:['ignore','pipe','pipe']});let output='';child.stderr?.on('data',data=>{output+=data;});
  try {
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(`${base}/api/health`)).ok)break;}catch{/*startup*/}await wait(50);}
    assert.equal((await fetch(`${base}/api/social/karim`)).status,401);
    const signup=await fetch(`${base}/api/auth/signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SocialTester',password:'social-password-1234',confirmPassword:'social-password-1234'})});assert.equal(signup.status,201);const cookie=signup.headers.get('set-cookie')!.split(';')[0];
    let data:{relationships:unknown[];memories:{provenance:string}[]}|undefined;
    for(let i=0;i<50;i++){data=await(await fetch(`${base}/api/social/karim`,{headers:{Cookie:cookie}})).json();if(data!.memories.length)break;await wait(50);}
    assert.equal(data!.relationships.length,9);assert.ok(data!.memories.length>0);assert.ok(data!.memories.some(m=>m.provenance==='told'||m.provenance==='observation'));
    const text=JSON.stringify(data);assert.ok(!text.includes('secret-'));assert.ok(!text.includes('secretsKnown'));assert.ok(!text.includes('truth_status'));assert.ok(!text.includes('goals'));
    assert.equal((await fetch(`${base}/api/social/karim/context`,{headers:{Cookie:cookie}})).status,404);assert.equal((await fetch(`${base}/api/social/karim`,{method:'POST',headers:{Cookie:cookie}})).status,404);
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
