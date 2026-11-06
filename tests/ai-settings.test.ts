import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync,statSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/src/app.js';
import { openWorld,type WorldDatabase } from '../server/src/db/index.js';
import { AiScheduler } from '../server/src/ai/scheduler.js';
import { RuntimeAiSettings } from '../server/src/ai/settings.js';
import { AiFailure,type AiTask,type Transport } from '../server/src/ai/types.js';
import type { AiSettingsView } from '../shared/ai.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ready:AiTask<{ready:boolean}>={id:'test',purpose:'test',system:'JSON',prompt:'Ready?',schema:{type:'object',properties:{ready:{type:'boolean'}},required:['ready']},parse:v=>{if(!v||typeof v!=='object'||(v as {ready?:boolean}).ready!==true)throw new Error('bad');return {ready:true};},fallback:()=>({ready:true}),urgent:true};
const good=()=>({value:{ready:true},inputTokens:10,outputTokens:5});
const fixture=(db:WorldDatabase)=>{db.prepare('INSERT INTO players(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)').run('admin','FixtureAdmin','unused','admin',new Date().toISOString());};
const metadata=(label='Primary',kind='gemini')=>({label,kind,model:'test-model',enabled:true,priority:0});

test('keys, master-file permissions, runtime choices, and world state persist without plaintext API/audit leakage',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-settings-')),url=`file:${join(dir,'world.db')}`,secret='fixture-storage-secret-12345';let db=openWorld(url);fixture(db);let seen='';let ai=new AiScheduler([],{transport:async(_p,key)=>{seen=key!.value;return good();}});let settings=new RuntimeAiSettings(db,ai,[]);
  try {const world=db.prepare('SELECT * FROM world').get();settings.saveProvider('admin',undefined,metadata());const id=settings.view().providers[0].id;settings.saveKey('admin',id,undefined,{label:'First key',value:secret,enabled:true});settings.setActive('admin',{providerId:id});
    const encrypted=(db.prepare('SELECT encrypted_key FROM ai_keys').get() as {encrypted_key:string}).encrypted_key;assert.ok(encrypted.startsWith('v1.'));assert.ok(!encrypted.includes(secret));assert.ok(!JSON.stringify(settings.view()).includes(secret));assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ai_audit').all()).includes(secret));assert.equal(statSync(join(dir,'.ai-encryption-key')).mode&0o777,0o600);assert.equal(readFileSync(join(dir,'.ai-encryption-key')).length,32);assert.deepEqual(db.prepare('SELECT * FROM world').get(),world);
    ai.stop();db.close();db=openWorld(url);ai=new AiScheduler([],{transport:async(_p,key)=>{seen=key!.value;return good();}});settings=new RuntimeAiSettings(db,ai,[]);assert.equal(settings.view().activeProviderId,id);assert.equal((await ai.runDetailed({...ready,id:'after-restart'})).source,'network');assert.equal(seen,secret);assert.equal(settings.view().providers[0].keys.length,1);assert.deepEqual(db.prepare('SELECT * FROM world').get(),world);
  }finally{ai.stop();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('live active selection, fallback ordering, key rotation, enable/disable, and endpoint changes are controlled',async()=>{
  const db=openWorld(':memory:');fixture(db);const calls:{provider:string;key:string}[]=[];const ai=new AiScheduler([],{transport:async(p,key)=>{calls.push({provider:p.id,key:key!.value});return good();}}),settings=new RuntimeAiSettings(db,ai,[]);
  try {settings.saveProvider('admin',undefined,metadata('A'));const a=settings.view().providers[0].id;settings.saveKey('admin',a,undefined,{label:'A1',value:'key-A1'});settings.saveKey('admin',a,undefined,{label:'A2',value:'key-A2'});await ai.run({...ready,id:'rotate1'});await ai.run({...ready,id:'rotate2'});assert.notEqual(calls[0].key,calls[1].key);
    settings.saveProvider('admin',undefined,{...metadata('B','groq'),priority:100});const b=settings.view().providers.find(p=>p.label==='B')!.id;settings.saveKey('admin',b,undefined,{value:'key-B'});settings.setActive('admin',{providerId:b});await ai.run({...ready,id:'prefer-b'});assert.equal(calls.at(-1)!.provider,b);
    settings.saveProvider('admin',b,{enabled:false});await ai.run({...ready,id:'disabled-b'});assert.equal(calls.at(-1)!.provider,a);
    const first=settings.view().providers.find(p=>p.id===a)!.keys[0];settings.saveKey('admin',a,first.id,{enabled:false});await ai.run({...ready,id:'disabled-key'});assert.equal(calls.at(-1)!.key,'key-A2');
    settings.saveProvider('admin',a,{kind:'groq',baseUrl:'https://api.groq.com/openai/v1'});assert.ok(settings.view().providers.find(p=>p.id===a)!.keys.every(k=>!k.enabled));assert.equal((await ai.runDetailed({...ready,id:'changed-origin'})).source,'local');
    settings.removeKey('admin',a,first.id);settings.removeProvider('admin',b);assert.equal(settings.view().activeProviderId,null);assert.ok(settings.view().audit.some(a=>a.action==='remove-provider'));
  }finally{ai.stop();db.close();}
});

test('shared 429 cooldown persists over restart and a new key cannot erase it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-quota-')),url=`file:${join(dir,'world.db')}`;let db=openWorld(url);fixture(db);let count=0;const transport:Transport=async()=>{count++;throw new AiFailure('rate_limited',60000);};let ai=new AiScheduler([],{transport}),settings=new RuntimeAiSettings(db,ai,[]);
  try {settings.saveProvider('admin',undefined,metadata());const id=settings.view().providers[0].id;settings.saveKey('admin',id,undefined,{value:'old-key'});assert.equal((await ai.runDetailed({...ready,id:'quota1'})).reason,'rate_limited');assert.equal(count,1);ai.stop();db.close();db=openWorld(url);ai=new AiScheduler([],{transport});settings=new RuntimeAiSettings(db,ai,[]);settings.saveKey('admin',id,undefined,{value:'rotated-key'});assert.ok(settings.view().providers[0].status.cooldownUntil>Date.now());assert.equal((await ai.runDetailed({...ready,id:'quota2'})).reason,'rate_limited');assert.equal(count,1);
  }finally{ai.stop();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('old in-flight failures cannot disable a newly replaced credential',async()=>{
  const db=openWorld(':memory:');fixture(db);let rejectOld!:(error:Error)=>void,calls=0;const ai=new AiScheduler([],{transport:async(_p,key)=>{calls++;if(key!.value==='old-key')return await new Promise((_,reject)=>{rejectOld=reject;});return good();}}),settings=new RuntimeAiSettings(db,ai,[]);
  try {settings.saveProvider('admin',undefined,metadata());const id=settings.view().providers[0].id;settings.saveKey('admin',id,undefined,{value:'old-key'});const keyId=settings.view().providers[0].keys[0].id,pending=ai.runDetailed({...ready,id:'old-request'});for(let i=0;i<20&&!rejectOld;i++)await wait(10);assert.equal(calls,1);settings.saveKey('admin',id,keyId,{value:'new-key'});rejectOld(new AiFailure('invalid_key'));await pending;assert.equal(settings.view().providers[0].keys[0].lastError,null);assert.equal((await ai.runDetailed({...ready,id:'new-request'})).source,'network');assert.equal(calls,2);
  }finally{ai.stop();db.close();}
});

test('unavailable encryption keys degrade to local policy rather than resetting or stopping the world',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-missing-key-')),url=`file:${join(dir,'world.db')}`;let db=openWorld(url);fixture(db);let ai=new AiScheduler([]),settings=new RuntimeAiSettings(db,ai,[]);
  try {settings.saveProvider('admin',undefined,metadata());const id=settings.view().providers[0].id;settings.saveKey('admin',id,undefined,{value:'private-key'});ai.stop();db.close();rmSync(join(dir,'.ai-encryption-key'));db=openWorld(url);ai=new AiScheduler([]);settings=new RuntimeAiSettings(db,ai,[]);assert.equal((await ai.runDetailed({...ready,id:'missing-master'})).source,'local');assert.equal(settings.view().providers[0].keys[0].lastError,'key_unavailable');assert.equal((db.prepare('SELECT count(*) n FROM citizens').get() as {n:number}).n,10);
  }finally{ai.stop();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('actual admin APIs perform redacted audited CRUD; non-admins and unsafe URLs are rejected',async()=>{
  const db=openWorld(':memory:'),ai=new AiScheduler([],{transport:async()=>good()}),settings=new RuntimeAiSettings(db,ai,[]),server=createApp(undefined,db,ai,settings).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,saved=process.env.ADMIN_SECRET;process.env.ADMIN_SECRET='fixture-bootstrap-secret-at-least-32-chars';
  const request=async(path:string,method='GET',body?:unknown,cookie?:string)=>fetch(`${base}/api${path}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  try {assert.equal((await request('/admin/ai/providers')).status,401);const signup=await request('/auth/signup','POST',{username:'RegularPlayer',password:'password-1234',confirmPassword:'password-1234'}),playerCookie=signup.headers.get('set-cookie')!.split(';')[0];assert.equal((await request('/admin/ai/providers','GET',undefined,playerCookie)).status,403);
    const admin=await fetch(`${base}/api/auth/admin/bootstrap`,{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':process.env.ADMIN_SECRET},body:JSON.stringify({username:'SettingsAdmin',password:'password-1234',confirmPassword:'password-1234'})});assert.equal(admin.status,201);const cookie=admin.headers.get('set-cookie')!.split(';')[0];
    const create=await request('/admin/ai/providers','POST',metadata(),cookie);assert.equal(create.status,200);let view=await create.json() as AiSettingsView;const id=view.providers[0].id;
    const add=await request(`/admin/ai/providers/${id}/keys`,'POST',{label:'Fixture',value:'not-returned-api-secret'},cookie);assert.equal(add.status,200);const text=await add.text();assert.ok(!text.includes('not-returned-api-secret'));view=JSON.parse(text);const key=view.providers[0].keys[0];assert.equal(key.configured,true);
    assert.equal((await request('/admin/ai/active','PUT',{providerId:id},cookie)).status,200);const probe=await request(`/admin/ai/providers/${id}/test`,'POST',undefined,cookie);assert.equal((await probe.json()).source,'network');
    assert.equal((await request(`/admin/ai/providers/${id}`,'PATCH',{model:'different-model'},cookie)).status,200);assert.equal((await request(`/admin/ai/providers/${id}/keys/${key.id}`,'PATCH',{enabled:false},cookie)).status,200);
    assert.equal((await request(`/admin/ai/providers/${id}`,'PATCH',{kind:'compatible',baseUrl:'https://127.0.0.1'},cookie)).status,400);assert.equal((await request('/admin/ai/providers','POST',{...metadata(),keys:[{value:'must-not-be-accepted'}]},cookie)).status,400);
    const state=await(await request('/admin/ai/providers','GET',undefined,cookie)).json() as AiSettingsView;assert.equal(state.providers[0].model,'different-model');assert.ok(state.audit.some(x=>x.action==='connection-test'));assert.equal((await request(`/admin/ai/providers/${id}/keys/${key.id}`,'DELETE',undefined,cookie)).status,200);assert.equal((await request(`/admin/ai/providers/${id}`,'DELETE',undefined,cookie)).status,200);assert.equal(settings.view().providers.length,0);assert.equal((db.prepare('SELECT count(*) n FROM citizens').get() as {n:number}).n,10);
  }finally{if(saved===undefined)delete process.env.ADMIN_SECRET;else process.env.ADMIN_SECRET=saved;ai.stop();await new Promise<void>(r=>server.close(()=>r()));db.close();}
});
