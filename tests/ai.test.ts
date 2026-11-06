import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiScheduler } from '../server/src/ai/scheduler.js';
import { defaultTransport,defaults,validateEndpoint } from '../server/src/ai/transport.js';
import { normalizeProvider,providersFromEnvironment } from '../server/src/ai/config.js';
import { AiFailure,type AiTask,type ProviderConfig,type ProviderKind,type Transport } from '../server/src/ai/types.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const schema={type:'object',properties:{answer:{type:'integer'}},required:['answer'],additionalProperties:false};
const parse=(v:unknown)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==1||!Number.isInteger((v as {answer:unknown}).answer))throw new Error('Invalid');return v as {answer:number};};
const task=(id:string,extra:Partial<AiTask<{answer:number}>>={}):AiTask<{answer:number}>=>({id,purpose:'test',system:'Return JSON only.',prompt:'Answer 7.',schema,parse,fallback:()=>({answer:7}),...extra});
const provider=(id='a',kind:ProviderKind='gemini'):ProviderConfig=>({id,label:id,kind,baseUrl:defaults(kind).baseUrl,model:'test-model',enabled:true,priority:0,jsonMode:kind==='nim'?'prompt':'schema',keys:[{id:'one',value:'dummy-secret-one',enabled:true},{id:'two',value:'dummy-secret-two',enabled:true}]});
const output=(answer=7)=>({value:{answer},inputTokens:10,outputTokens:5});

test('empty/malformed configuration uses validated local policies without sandbox credentials',async()=>{
  const ai=new AiScheduler([],{transport:async()=>{throw new Error('Must not call');}});
  assert.equal((await ai.runDetailed(task('empty'))).source,'local');assert.equal(ai.summary().localFallbacks,1);ai.stop();
  const saved=process.env.AI_PROVIDERS_JSON;process.env.AI_PROVIDERS_JSON='{bad';try{assert.deepEqual(providersFromEnvironment(),[]);}finally{if(saved===undefined)delete process.env.AI_PROVIDERS_JSON;else process.env.AI_PROVIDERS_JSON=saved;}
  assert.throws(()=>normalizeProvider({...provider(),baseUrl:'https://user:secret@api.example.com'}));
});

test('all six vendor transports make actual structured HTTP calls with normalized payloads and usage',async()=>{
  const captured:{path:string;header:string|undefined;body:Record<string,unknown>}[]=[];
  const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text) as Record<string,unknown>;captured.push({path:req.url!,header:(req.headers['x-goog-api-key']??req.headers.authorization) as string|undefined,body});res.setHeader('Content-Type','application/json');
    if(req.url?.includes(':generateContent'))res.end(JSON.stringify({candidates:[{content:{parts:[{text:'```json\n{"answer":7}\n```'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}}));
    else if(req.url==='/api/chat')res.end(JSON.stringify({message:{content:'{"answer":7}'},prompt_eval_count:10,eval_count:5}));
    else res.end(JSON.stringify({choices:[{message:{content:'{"answer":7}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,saved=process.env.AI_ALLOWED_ORIGINS;process.env.AI_ALLOWED_ORIGINS=origin;
  try {
    for(const kind of ['gemini','nim','openrouter','groq','ollama','compatible'] as ProviderKind[]){const prefix=kind==='openrouter'?'/api/v1':kind==='groq'?'/openai/v1':kind==='nim'||kind==='compatible'?'/v1':'';const p={...provider(kind,kind),baseUrl:origin+prefix,jsonMode:kind==='nim'?'prompt' as const:kind==='gemini'||kind==='ollama'?'schema' as const:'object' as const};const result=await defaultTransport(p,p.keys[0],{system:'Test',prompt:'Return answer 7',schema,maxOutputTokens:64},new AbortController().signal);assert.deepEqual(result.value,{answer:7});assert.equal(result.inputTokens,10);assert.equal(result.outputTokens,5);}
    assert.match(captured[0].path,/:generateContent/);assert.equal(captured[0].header,'dummy-secret-one');assert.equal((captured[0].body.generationConfig as {responseSchema:{type:string}}).responseSchema.type,'OBJECT');
    assert.ok(!('response_format' in captured[1].body));assert.equal(captured[1].header,'Bearer dummy-secret-one');assert.equal((captured[2].body.response_format as {type:string}).type,'json_object');assert.equal(captured[4].path,'/api/chat');assert.equal(captured[4].body.stream,false);
    assert.equal(captured[1].path,'/v1/chat/completions');assert.equal(captured[2].path,'/api/v1/chat/completions');assert.equal(captured[3].path,'/openai/v1/chat/completions');assert.equal(captured[5].path,'/v1/chat/completions');
    const hostnameOrigin=origin.replace('127.0.0.1','localhost');process.env.AI_ALLOWED_ORIGINS=hostnameOrigin;
    assert.deepEqual((await defaultTransport({...provider('dns','compatible'),baseUrl:hostnameOrigin+'/v1'},provider().keys[0],{system:'',prompt:'',schema,maxOutputTokens:64},new AbortController().signal)).value,{answer:7});
  }finally{if(saved===undefined)delete process.env.AI_ALLOWED_ORIGINS;else process.env.AI_ALLOWED_ORIGINS=saved;await new Promise<void>(r=>server.close(()=>r()));}
});

test('unsafe endpoints, redirects, malformed bodies, HTTP errors, and oversized responses are rejected',async()=>{
  assert.throws(()=>validateEndpoint('compatible','http://169.254.169.254'));assert.throws(()=>validateEndpoint('compatible','https://127.0.0.1'));assert.throws(()=>validateEndpoint('gemini','https://evil.example'));assert.throws(()=>validateEndpoint('compatible','https://example.com?key=secret'));validateEndpoint('ollama','http://127.0.0.1:11434');
  assert.throws(()=>validateEndpoint('compatible','https://[::ffff:7f00:1]'));assert.throws(()=>validateEndpoint('compatible','https://[::1]'));
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const {model}=JSON.parse(raw) as {model:string};if(model==='redirect'){res.writeHead(302,{Location:'http://169.254.169.254'});res.end();}else if(model==='large')res.end('x'.repeat(270000));else if(model==='bad')res.end('not json');else{res.statusCode=Number(model);res.setHeader('Retry-After','2');res.end('{}');}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`,saved=process.env.AI_ALLOWED_ORIGINS;process.env.AI_ALLOWED_ORIGINS=origin;
  try {for(const [model,code] of [['401','invalid_key'],['429','rate_limited'],['500','server_error'],['bad','invalid_output'],['large','invalid_output']] as const){await assert.rejects(defaultTransport({...provider('x','compatible'),baseUrl:origin,model},provider().keys[0],{system:'',prompt:'',schema,maxOutputTokens:64},new AbortController().signal),(error:unknown)=>error instanceof AiFailure&&error.code===code);}
    await assert.rejects(defaultTransport({...provider('x','compatible'),baseUrl:origin,model:'redirect'},provider().keys[0],{system:'',prompt:'',schema,maxOutputTokens:64},new AbortController().signal));
  }finally{if(saved===undefined)delete process.env.AI_ALLOWED_ORIGINS;else process.env.AI_ALLOWED_ORIGINS=saved;await new Promise<void>(r=>server.close(()=>r()));}
});

test('429 backoff is shared across profiles and keys; rotating keys never creates more quota',async()=>{
  const a=provider('a'),clone={...provider('clone'),priority:1},b={...provider('b','groq'),priority:2};let primary=0,secondary=0;
  const transport:Transport=async(p)=>{if(p.kind==='gemini'){primary++;throw new AiFailure('rate_limited',60000);}secondary++;return output();};
  const ai=new AiScheduler([a,clone,b],{transport,now:()=>1000});try {
    assert.equal((await ai.runDetailed(task('first'))).providerId,'b');assert.equal(primary,1);
    ai.updateProviders([{...a,keys:[{id:'new',value:'rotated-key',enabled:true}]},clone,b]);assert.equal((await ai.runDetailed(task('second'))).providerId,'b');assert.equal(primary,1);assert.equal(secondary,2);assert.ok(ai.statuses().filter(s=>s.id!=='b').every(s=>s.cooldownUntil>1000));assert.ok(!JSON.stringify(ai.summary()).includes('rotated-key'));
  }finally{ai.stop();}
});

test('invalid credentials rotate at most once while preserving individual key backoff',async()=>{
  let calls=0;const ai=new AiScheduler([provider()],{transport:async(_p,key)=>{calls++;if(key!.id==='one')throw new AiFailure('invalid_key');return output();}});try {assert.equal((await ai.runDetailed(task('valid-second-key'))).source,'network');assert.equal(calls,2);assert.ok(ai.statuses()[0].keys[0].cooldownUntil>Date.now());await ai.run(task('again'));assert.equal(calls,3);assert.ok(!JSON.stringify(ai.summary()).includes('dummy-secret'));}finally{ai.stop();}
});

test('timeouts and invalid model output fall back within bounds without blocking other queued work',async()=>{
  let calls=0;const ai=new AiScheduler([provider()],{transport:async()=>{calls++;return await new Promise(()=>{});},timeoutMs:20});try {assert.equal((await ai.runDetailed(task('timeout',{timeoutMs:100}))).source,'local');assert.equal(calls,2);}finally{ai.stop();}
  const malformed=new AiScheduler([provider()],{transport:async()=>({...output(),value:{wrong:true}})});try{const result=await malformed.runDetailed(task('bad-schema'));assert.equal(result.source,'local');assert.equal(result.reason,'validation_error');}finally{malformed.stop();}
});

test('request/token budgets, idle wake-up, and explicit batching preserve private actor boundaries',async()=>{
  let now=1000,calls=0;const ai=new AiScheduler([provider()],{transport:async()=>{calls++;return output();},now:()=>now});
  try {await ai.run(task('idle-first',{actorId:'karim'}));assert.equal((await ai.runDetailed(task('idle-again',{actorId:'karim'}))).source,'local');ai.setActivePlayers(1);now+=45000;assert.equal((await ai.runDetailed(task('woke',{actorId:'karim'}))).source,'network');assert.equal(calls,2);}finally{ai.stop();}
  const none=new AiScheduler([provider()],{transport:async()=>{throw new Error('Budget must block');},requestBudget:0});try{assert.equal((await none.runDetailed(task('budget'))).reason,'budget_exhausted');}finally{none.stop();}
  const tokens=new AiScheduler([provider()],{transport:async()=>{throw new Error('Token budget must block');},tokenBudget:0});try{assert.equal((await tokens.runDetailed(task('tokens'))).reason,'budget_exhausted');}finally{tokens.stop();}
  let batchCalls=0;const batch=new AiScheduler([provider()],{transport:async(_p,_k,request)=>{batchCalls++;const {requests}=JSON.parse(request.prompt) as {requests:{id:string;prompt:string}[]};return {value:{results:requests.reverse().map(r=>({id:r.id,value:{answer:Number(r.prompt)}}))},inputTokens:10,outputTokens:5};}});
  try{const values=await Promise.all([1,2,3].map(n=>batch.run(task(`batch-${n}`,{prompt:String(n),batchable:true}))));assert.deepEqual(values.map(v=>v.answer),[1,2,3]);assert.equal(batchCalls,1);}finally{batch.stop();}
  let privateCalls=0;const isolated=new AiScheduler([provider()],{transport:async()=>{privateCalls++;return output();}});try{await Promise.all(['karim','laila'].map(actorId=>isolated.run(task(`private-${actorId}`,{actorId,batchable:true}))));assert.equal(privateCalls,2);}finally{isolated.stop();}
});

test('the production no-key server keeps ticking and exposes diagnostics only to admins',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wust-ai-')),base='http://127.0.0.1:3018',secret='test-admin-bootstrap-secret-123456789';
  const child=spawn(process.execPath,['dist/server/server/src/index.js'],{env:{...process.env,PORT:'3018',DATABASE_URL:`file:${join(dir,'world.db')}`,SIMULATION_TICK_MS:'100',ADMIN_SECRET:secret,AI_PROVIDERS_JSON:'[]',GEMINI_API_KEY:'',OPENAI_COMPATIBLE_BASE_URL:'',OPENAI_API_KEY:'do-not-use-sandbox-key'},stdio:['ignore','pipe','pipe']});let output='';child.stderr?.on('data',data=>{output+=data;});
  try {
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(`${base}/api/health`)).ok)break;}catch{/*startup*/}await wait(50);}
    assert.equal((await fetch(`${base}/api/admin/ai/status`)).status,401);const a=await(await fetch(`${base}/api/world/summary`)).json();
    const bootstrap=await fetch(`${base}/api/auth/admin/bootstrap`,{method:'POST',headers:{'Content-Type':'application/json','x-admin-secret':secret},body:JSON.stringify({username:'AiAdminTester',password:'admin-password-1234',confirmPassword:'admin-password-1234'})});assert.equal(bootstrap.status,201);const cookie=bootstrap.headers.get('set-cookie')!.split(';')[0];
    const response=await fetch(`${base}/api/admin/ai/test`,{method:'POST',headers:{Cookie:cookie}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.source,'local');assert.equal(result.reason,'disabled');assert.deepEqual(result.value,{ready:true});
    await wait(250);const b=await(await fetch(`${base}/api/world/summary`)).json();assert.ok(b.tick>a.tick);const status=await(await fetch(`${base}/api/admin/ai/status`,{headers:{Cookie:cookie}})).json();assert.equal(status.providers.length,0);assert.ok(status.localFallbacks>=1);
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
