import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { openWorld,type WorldDatabase } from '../server/src/db/index.js';
import { SimulationClock } from '../server/src/simulation/clock.js';
import { AiScheduler } from '../server/src/ai/scheduler.js';
import { attachCitizenReasoning } from '../server/src/citizens/reasoning.js';
import { captureCitizenFrame,applyCitizenAction,parseCitizenAction } from '../server/src/citizens/actions.js';
import { waitAction,type CitizenAction } from '../server/src/citizens/reasoning-types.js';
import { localCitizenPolicy } from '../server/src/citizens/policy.js';
import { entrance,walkable } from '../server/src/simulation/navigation.js';
import { publicEvents } from '../server/src/realtime/projection.js';
import type { TownBuilding } from '../shared/world.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function together(db:WorldDatabase){const buildings=db.prepare('SELECT * FROM buildings').all() as TownBuilding[],square=buildings.find(b=>b.id==='square')!,first=entrance(square,buildings,new Set(),'karim')!;const second=[{x:first.x+1,y:first.y},{x:first.x-1,y:first.y},{x:first.x,y:first.y+1},{x:first.x,y:first.y-1}].find(p=>walkable(p,buildings))!;
  for(const [id,p] of [['karim',first],['mostafa',second]] as const){db.prepare("UPDATE citizens SET x=?,y=?,building_id='square',activity='socializing',needs=? WHERE id=?").run(p.x,p.y,JSON.stringify({hunger:10,energy:90,social:95}),id);db.prepare("UPDATE citizen_routines SET goal_action='socialize',target_building_id='square',path='[]',next_decision_game_ms=0,next_speech_game_ms=0 WHERE citizen_id=?").run(id);}}
const modelProvider={id:'mock',label:'Mock',kind:'gemini' as const,baseUrl:'https://generativelanguage.googleapis.com',model:'mock',enabled:true,priority:0,jsonMode:'schema' as const,keys:[{id:'key',value:'fake-key',enabled:true}]};
const speech=(text='A claim I cannot independently verify.'):CitizenAction=>({...waitAction(),action:'speak',target:'mostafa',text,stance:'belief'});

test('perception contains only own knowledge and nearby public peers, not other secrets or human chat',()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db);
  try {const state=clock.state(),result=db.prepare("INSERT INTO events(world_version,game_time_ms,type,actor_id,target,visibility,details) VALUES(?,?,'citizen_spoke','laila','dina','private',?)").run(state.version,state.game_time_ms,JSON.stringify({text:'FOREIGN_PRIVATE_MARKER'}));db.prepare('INSERT INTO conversations(game_time_ms,speaker_id,recipient_id,text,source_event_id) VALUES(?,?,?,?,?)').run(state.game_time_ms,'laila','dina','FOREIGN_PRIVATE_MARKER',result.lastInsertRowid);
    db.prepare("INSERT INTO players(id,username,password_hash,role,created_at) VALUES('human','Human','x','player',?)").run(new Date().toISOString());db.prepare('INSERT INTO observer_messages(player_id,text,created_at,game_time_ms) VALUES(?,?,?,?)').run('human','HUMAN_CHAT_MARKER',new Date().toISOString(),state.game_time_ms);
    const frame=captureCitizenFrame(db,state,'karim'),foreign=(db.prepare("SELECT claim FROM secrets WHERE owner_id='laila'").get() as {claim:string}).claim,serialized=JSON.stringify(frame);assert.ok(!serialized.includes('FOREIGN_PRIVATE_MARKER'));assert.ok(!serialized.includes('HUMAN_CHAT_MARKER'));assert.ok(!serialized.includes(foreign));assert.ok(frame.nearby.some(p=>p.id==='mostafa'));assert.ok(!frame.nearby.some(p=>p.id==='laila'));assert.ok(frame.sources.every(s=>s.id.startsWith('memory:')||s.id.startsWith('knowledge:')||s.id.startsWith('secret:')||s.id.startsWith('conversation:')));
  }finally{clock.stop();db.close();}
});

test('one validator rejects malformed, omniscient, distant, stale, and unsafe destination proposals',()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db);try{const frame=captureCitizenFrame(db,clock.state(),'karim');assert.throws(()=>parseCitizenAction({...waitAction(),x:80,y:50}));assert.throws(()=>parseCitizenAction({...waitAction(),amount:NaN}));assert.throws(()=>applyCitizenAction(db,clock.state(),frame,waitAction(),'outside'));
    const apply=(action:CitizenAction,state=clock.state())=>db.transaction(()=>applyCitizenAction(db,state,frame,action,'validate'))();
    assert.equal(apply({...speech(),sources:['secret:foreign-secret']}).reason,'unknown_source');assert.equal(apply({...speech(),stance:'observation',sources:[]}).reason,'unsupported_observation');assert.equal(apply({...speech(),target:'laila'}).reason,'unknown_peer');assert.equal(apply({...waitAction(),action:'go',target:'missing'}).reason,'unknown_building');assert.equal(apply({...waitAction(),action:'go',target:'police',goal:'work'}).reason,'invalid_destination');assert.equal(apply(speech(),{...clock.state(),game_time_ms:frame.gameTimeMs+120001}).reason,'stale_response');
  }finally{clock.stop();db.close();}
});

test('speech is an attributed claim, not a rewrite of committed facts; private lie intent is not public',()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db);try{const state=clock.state(),truth=db.prepare("INSERT INTO events(world_version,game_time_ms,type,actor_id,target,amount,importance,visibility,details) VALUES(?,?,'purchase','karim','cafe',2500,0,'public','{}')").run(state.version,state.game_time_ms);const before=db.prepare('SELECT * FROM events WHERE id=?').get(truth.lastInsertRowid),frame=captureCitizenFrame(db,state,'karim');const result=clock.commitCommand('lie-speech',(db,state)=>applyCitizenAction(db,state,frame,{...speech('I think the cafe was closed, though I may be wrong.'),stance:'lie'},'lie-speech','network'));assert.equal(result.accepted,true);assert.deepEqual(db.prepare('SELECT * FROM events WHERE id=?').get(truth.lastInsertRowid),before);
    const row=db.prepare('SELECT * FROM conversations WHERE source_event_id=?').get(result.eventId) as {speaker_id:string;recipient_id:string;stance:string;origin:string};assert.equal(row.speaker_id,'karim');assert.equal(row.recipient_id,'mostafa');assert.equal(row.stance,'lie');assert.equal(row.origin,'network');assert.ok(!JSON.stringify(publicEvents(db,Number(truth.lastInsertRowid),100)).includes('"stance"'));assert.ok((db.prepare("SELECT count(*) n FROM observed_events WHERE citizen_id='mostafa' AND event_id=? AND mode='told'").get(result.eventId) as {n:number}).n>0);
  }finally{clock.stop();db.close();}
});

test('money proposals recheck current balances and replay cannot duplicate transfers',()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db);try{const frame=captureCitizenFrame(db,clock.state(),'karim'),total=(db.prepare('SELECT sum(money) n FROM citizens').get() as {n:number}).n;
    const first=clock.commitCommand('gift',(db,state)=>applyCitizenAction(db,state,frame,{...waitAction(),action:'transfer',target:'mostafa',amount:40000},'gift'));assert.equal(first.accepted,true);clock.commitCommand('gift',()=>{throw new Error('Must not replay');});const stale=clock.commitCommand('spent-funds',(db,state)=>applyCitizenAction(db,state,frame,{...waitAction(),action:'transfer',target:'mostafa',amount:frame.self.money},'spent-funds'));assert.equal(stale.accepted,false);assert.equal(stale.reason,'insufficient_funds');assert.equal((db.prepare("SELECT count(*) n FROM money_transactions WHERE id='gift'").get() as {n:number}).n,1);assert.equal((db.prepare('SELECT sum(money) n FROM citizens').get() as {n:number}).n,total);
  }finally{clock.stop();db.close();}
});

test('go proposals produce a walkable path without changing coordinates immediately',()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db);try{const frame=captureCitizenFrame(db,clock.state(),'karim'),position={x:frame.self.x,y:frame.self.y};const result=clock.commitCommand('go-home',(db,state)=>applyCitizenAction(db,state,frame,{...waitAction(),action:'go',target:frame.self.homeId,goal:'sleep'},'go-home'));assert.equal(result.accepted,true);assert.deepEqual(db.prepare("SELECT x,y FROM citizens WHERE id='karim'").get(),position);const route=JSON.parse((db.prepare("SELECT path FROM citizen_routines WHERE citizen_id='karim'").get() as {path:string}).path) as {x:number;y:number}[];assert.ok(route.length>0);let current=position;for(const p of route){assert.equal(Math.abs(p.x-current.x)+Math.abs(p.y-current.y),1);assert.ok(walkable(p,frame.buildings));current=p;}
  }finally{clock.stop();db.close();}
});

test('no-key local thinking records provenance and uses the same legal action gate',async()=>{
  const db=openWorld(':memory:');together(db);const clock=new SimulationClock(db),ai=new AiScheduler([]),thinking=attachCitizenReasoning(db,clock,ai);try{const frame=captureCitizenFrame(db,clock.state(),'karim','heard_dialogue');assert.equal(localCitizenPolicy(frame).action,'speak');const result=await thinking.think('karim','heard_dialogue');assert.equal(result?.accepted,true);assert.ok((db.prepare("SELECT count(*) n FROM citizen_decisions WHERE citizen_id='karim' AND origin='local'").get() as {n:number}).n>0);const row=db.prepare("SELECT speaker_id,recipient_id,origin FROM conversations WHERE speaker_id='karim' ORDER BY id DESC LIMIT 1").get() as {recipient_id:string;origin:string};assert.equal(row.recipient_id,'mostafa');assert.equal(row.origin,'local');}finally{thinking.stop();ai.stop();clock.stop();db.close();}
});

test('late model replies cannot apply stale speech after the clock has moved on',async()=>{
  const db=openWorld(':memory:');together(db);let resolveOld!:(value:{value:CitizenAction;inputTokens:number;outputTokens:number})=>void,calls=0;const clock=new SimulationClock(db),ai=new AiScheduler([modelProvider],{transport:async()=>{if(calls++===0)return await new Promise(resolve=>{resolveOld=resolve;});return {value:waitAction(),inputTokens:10,outputTokens:5};}}),thinking=attachCitizenReasoning(db,clock,ai);
  try{const pending=thinking.think('karim','heard_dialogue');for(let i=0;i<20&&!resolveOld;i++)await wait(10);assert.ok(resolveOld);clock.step(60000);resolveOld({value:speech('STALE_MODEL_MARKER'),inputTokens:10,outputTokens:5});await pending;assert.equal((db.prepare("SELECT count(*) n FROM conversations WHERE text LIKE '%STALE_MODEL_MARKER%'").get() as {n:number}).n,0);assert.ok(clock.state().tick>0);}finally{thinking.stop();ai.stop();clock.stop();db.close();}
});

test('production no-key ticks create persistent autonomous dialogue and decisions while the API remains live',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-thinking-')),path=join(dir,'world.db'),db=openWorld(`file:${path}`);together(db);db.close();const base='http://127.0.0.1:3019',child=spawn(process.execPath,['dist/server/server/src/index.js'],{env:{...process.env,PORT:'3019',DATABASE_URL:`file:${path}`,SIMULATION_TICK_MS:'100',AI_PROVIDERS_JSON:'[]',GEMINI_API_KEY:'',OPENAI_COMPATIBLE_BASE_URL:''},stdio:['ignore','pipe','pipe']});let errors='';child.stderr?.on('data',data=>{errors+=data;});
  try{for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(errors);try{if((await fetch(`${base}/api/health`)).ok)break;}catch{/*startup*/}await wait(50);}await wait(350);assert.equal((await fetch(`${base}/api/health`)).status,200);const saved=new Database(path,{readonly:true});try{assert.ok((saved.prepare('SELECT tick FROM world').get() as {tick:number}).tick>0);assert.ok((saved.prepare('SELECT count(*) n FROM citizen_decisions').get() as {n:number}).n>0);assert.ok((saved.prepare('SELECT count(*) n FROM conversations').get() as {n:number}).n>0);assert.ok((saved.prepare("SELECT count(*) n FROM conversations WHERE origin='local' AND source_event_id IS NOT NULL").get() as {n:number}).n>0);}finally{saved.close();}
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
