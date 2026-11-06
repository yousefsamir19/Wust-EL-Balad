import { createHash } from 'node:crypto';
import { AiFailure,type AiFailureCode,type AiResult,type AiTask,type ProviderConfig,type ProviderStatus,type Transport,type WireRequest } from './types.js';
import { defaultTransport } from './transport.js';
interface Job {task:AiTask<unknown>;resolve:(result:AiResult<unknown>)=>void;reject:(error:Error)=>void;expires:number;promise:Promise<AiResult<unknown>>}
interface State {cooldownUntil:number;lastError:AiFailureCode|null;lastSuccess:number|null;requests:number;inputTokens:number;outputTokens:number;keyIndex:number}
interface Options {transport?:Transport;requestBudget?:number;tokenBudget?:number;concurrency?:number;batchSize?:number;timeoutMs?:number;activeIntervalMs?:number;idleIntervalMs?:number;now?:()=>number;batchDelayMs?:number}
const state=():State=>({cooldownUntil:0,lastError:null,lastSuccess:null,requests:0,inputTokens:0,outputTokens:0,keyIndex:0});
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AiScheduler {
  private providers:ProviderConfig[]=[];private queue:Job[]=[];private pending=new Map<string,Job>();private states=new Map<string,State>();
  private keys=new Map<string,{fingerprint:string;cooldownUntil:number;lastError:AiFailureCode|null}>();
  private quotas=new Map<string,{until:number;failures:number}>();private requests:{at:number;provider:string;tokens:number}[]=[];
  private actors=new Map<string,number>();private controllers=new Set<AbortController>();private active=0;private stopped=false;private players=0;private fallbacks=0;
  private timer:ReturnType<typeof setTimeout>|undefined;private transport:Transport;private now:()=>number;
  constructor(providers:ProviderConfig[]=[],private options:Options={}){this.transport=options.transport??defaultTransport;this.now=options.now??Date.now;this.updateProviders(providers);}
  updateProviders(providers:ProviderConfig[]) {
    this.providers=providers.map(p=>({...p,keys:p.keys.map(k=>({...k}))})).sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
    for(const p of this.providers) {
      if(!this.states.has(p.id))this.states.set(p.id,state());
      const status=this.states.get(p.id)!;if(status.lastError!=='rate_limited'){status.cooldownUntil=0;status.lastError=null;}
      for(const key of p.keys){const id=`${p.id}/${key.id}`,hash=fingerprint(key.value);if(this.keys.get(id)?.fingerprint!==hash)this.keys.set(id,{fingerprint:hash,cooldownUntil:0,lastError:null});}
    }
    if(this.queue.length)this.schedule();
  }
  setActivePlayers(count:number){const next=Math.max(0,count);if(!this.players&&next){const limit=this.now()+(this.options.activeIntervalMs??30000);this.actors.forEach((time,id)=>this.actors.set(id,Math.min(time,limit)));}this.players=next;}
  statuses():ProviderStatus[]{return this.providers.map(p=>{const s=this.states.get(p.id)!;return {id:p.id,cooldownUntil:Math.max(s.cooldownUntil,this.quotas.get(new URL(p.baseUrl).origin)?.until??0),lastError:s.lastError,lastSuccess:s.lastSuccess,requests:s.requests,inputTokens:s.inputTokens,outputTokens:s.outputTokens,keys:p.keys.map(k=>({id:k.id,cooldownUntil:this.keys.get(`${p.id}/${k.id}`)?.cooldownUntil??0,lastError:this.keys.get(`${p.id}/${k.id}`)?.lastError??null}))};});}
  summary(){return {providers:this.statuses(),queued:this.queue.length,active:this.active,localFallbacks:this.fallbacks,activePlayers:this.players};}
  run<T>(task:AiTask<T>):Promise<T>{return this.runDetailed(task).then(result=>result.value);}
  runDetailed<T>(task:AiTask<T>):Promise<AiResult<T>> {
    const saved=this.pending.get(task.id);if(saved)return saved.promise as Promise<AiResult<T>>;
    const local=(reason:AiFailureCode)=>{this.fallbacks++;try{return Promise.resolve({value:task.parse(task.fallback()),source:'local' as const,providerId:null,reason});}catch{return Promise.reject(new AiFailure('validation_error'));}};
    if(this.stopped||!this.providers.some(p=>p.enabled&&p.model&&(p.kind==='ollama'||p.keys.some(k=>k.enabled&&k.value))))return local('disabled');
    if(this.queue.length>=64||task.prompt.length>12000||task.system.length>20000)return local('budget_exhausted');
    const now=this.now(),interval=task.urgent?5000:(this.players>0?this.options.activeIntervalMs??30000:this.options.idleIntervalMs??300000);
    if(task.actorId){if((this.actors.get(task.actorId)??0)>now)return local('budget_exhausted');this.actors.set(task.actorId,now+interval);if(this.actors.size>1024)this.actors.forEach((time,id)=>{if(time<=now)this.actors.delete(id);});}
    let resolve!:(result:AiResult<unknown>)=>void,reject!:(error:Error)=>void;
    const promise=new Promise<AiResult<unknown>>((yes,no)=>{resolve=yes;reject=no;});
    const job:Job={task:task as AiTask<unknown>,resolve,reject,promise,expires:now+Math.min(30000,Math.max(100,task.timeoutMs??12000))};
    this.pending.set(task.id,job);this.queue.push(job);this.queue.sort((a,b)=>Number(!!b.task.urgent)-Number(!!a.task.urgent));this.schedule();return promise as Promise<AiResult<T>>;
  }
  private schedule(){if(!this.timer&&!this.stopped)this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},this.options.batchDelayMs??10);}
  private compatible(a:Job,b:Job){return a.task.batchable&&b.task.batchable&&a.task.actorId===b.task.actorId&&a.task.purpose===b.task.purpose&&a.task.system===b.task.system&&JSON.stringify(a.task.schema)===JSON.stringify(b.task.schema);}
  private pump(){while(this.queue.length&&this.active<(this.options.concurrency??2)&&!this.stopped){const first=this.queue.shift()!,group=[first];for(let i=0;i<this.queue.length&&group.length<(this.options.batchSize??4);){if(this.compatible(first,this.queue[i]))group.push(this.queue.splice(i,1)[0]);else i++;}this.active++;void this.execute(group).finally(()=>{this.active--;this.pump();});}}
  private finish(job:Job,result:AiResult<unknown>){this.pending.delete(job.task.id);job.resolve(result);}
  private local(job:Job,reason:AiFailureCode){this.fallbacks++;this.pending.delete(job.task.id);try{job.resolve({value:job.task.parse(job.task.fallback()),source:'local',providerId:null,reason});}catch{job.reject(new AiFailure('validation_error'));}}
  private reserve(provider:ProviderConfig,request:WireRequest) {
    const now=this.now();this.requests=this.requests.filter(r=>r.at>now-60000);
    const tokens=Math.ceil((request.system.length+request.prompt.length+JSON.stringify(request.schema).length)/4)+request.maxOutputTokens;
    if(this.requests.length>=(this.options.requestBudget??20)||this.requests.filter(r=>r.provider===provider.id).length>=(provider.maxRequestsPerMinute??20)||this.requests.reduce((n,r)=>n+r.tokens,0)+tokens>(this.options.tokenBudget??30000))throw new AiFailure('budget_exhausted');
    const reservation={at:now,provider:provider.id,tokens};this.requests.push(reservation);return reservation;
  }
  private async wire(provider:ProviderConfig,key:ProviderConfig['keys'][number]|undefined,request:WireRequest,deadline:number) {
    const reservation=this.reserve(provider,request),s=this.states.get(provider.id)!;s.requests++;
    const controller=new AbortController();this.controllers.add(controller);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AiFailure('timeout'));},Math.max(1,Math.min(this.options.timeoutMs??5000,deadline-this.now())));});
      const result=await Promise.race([this.transport(provider,key,request,controller.signal),timeout]);
      s.inputTokens+=result.inputTokens;s.outputTokens+=result.outputTokens;if(result.inputTokens+result.outputTokens>0)reservation.tokens=result.inputTokens+result.outputTokens;return result;
    }catch(error){throw error instanceof AiFailure?error:new AiFailure('network_error');}finally{if(timer)clearTimeout(timer);this.controllers.delete(controller);}
  }
  private async execute(jobs:Job[]) {
    const deadline=Math.min(...jobs.map(j=>j.expires));let reason:AiFailureCode='disabled';
    const request:WireRequest={system:jobs[0].task.system,prompt:jobs.length===1?jobs[0].task.prompt:JSON.stringify({requests:jobs.map(j=>({id:j.task.id,prompt:j.task.prompt})),instruction:'Return exactly one result for each request id. Do not combine or change ids.'}),schema:jobs.length===1?jobs[0].task.schema:{type:'object',properties:{results:{type:'array',items:{type:'object',properties:{id:{type:'string',enum:jobs.map(j=>j.task.id)},value:jobs[0].task.schema},required:['id','value'],additionalProperties:false},minItems:jobs.length,maxItems:jobs.length}},required:['results'],additionalProperties:false},maxOutputTokens:Math.min(8192,jobs.reduce((n,j)=>n+(j.task.maxOutputTokens??512),0))};
    const providers=this.providers.map(p=>({...p,keys:p.keys.map(k=>({...k}))}));
    try {
      for(const p of providers) {
        if(this.stopped)break;const s=this.states.get(p.id)!,origin=new URL(p.baseUrl).origin;
        if(!p.enabled||!p.model||Math.max(s.cooldownUntil,this.quotas.get(origin)?.until??0)>this.now())continue;
        for(let attempt=0;attempt<2;attempt++) {
          if(this.stopped||this.now()>=deadline){reason='timeout';break;}
          const available=p.keys.filter(k=>k.enabled&&k.value&&(this.keys.get(`${p.id}/${k.id}`)?.cooldownUntil??0)<=this.now());
          if(!available.length&&p.kind!=='ollama')break;
          const key=available.length?available[s.keyIndex++%available.length]:undefined;
          try {
            const response=await this.wire(p,key,request,deadline);let values:unknown[];
            try {
              if(jobs.length===1)values=[jobs[0].task.parse(response.value)];
              else {const results=(response.value as {results?:{id:string;value:unknown}[]})?.results;if(!Array.isArray(results)||results.length!==jobs.length||new Set(results.map(r=>r.id)).size!==jobs.length||results.some(r=>!jobs.some(j=>j.task.id===r.id)))throw new Error('Invalid batch');values=jobs.map(j=>j.task.parse(results.find(r=>r.id===j.task.id)!.value));}
            }catch{throw new AiFailure('validation_error');}
            s.lastSuccess=this.now();s.lastError=null;s.cooldownUntil=0;this.quotas.delete(origin);if(key)this.keys.get(`${p.id}/${key.id}`)!.lastError=null;
            jobs.forEach((job,i)=>this.finish(job,{value:values[i],source:'network',providerId:p.id,reason:null}));return;
          } catch(error) {
            const failure=error instanceof AiFailure?error:new AiFailure('network_error');reason=failure.code;s.lastError=reason;
            if(reason==='budget_exhausted')break;
            if(key)this.keys.get(`${p.id}/${key.id}`)!.lastError=reason;
            if(reason==='invalid_key'){if(key)this.keys.get(`${p.id}/${key.id}`)!.cooldownUntil=this.now()+600000;continue;}
            if(reason==='rate_limited'){const q=this.quotas.get(origin)??{until:0,failures:0};q.failures++;q.until=this.now()+Math.min(3600000,Math.max(1000*2**Math.min(q.failures,12),failure.retryAfterMs));this.quotas.set(origin,q);s.cooldownUntil=q.until;break;}
            if(reason==='invalid_output'||reason==='validation_error'||reason==='unsafe_endpoint'){s.cooldownUntil=this.now()+60000;break;}
            if(attempt===1){s.cooldownUntil=this.now()+2000;break;}
          }
        }
      }
    }catch(error){reason=error instanceof AiFailure?error.code:'network_error';}
    jobs.forEach(job=>this.local(job,reason));
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.controllers.forEach(c=>c.abort());for(const job of this.queue.splice(0))this.local(job,'disabled');}
}
