import { AiFailure,type ProviderConfig,type ProviderKind,type ProviderKey } from './types.js';
import { defaults,validateEndpoint } from './transport.js';
const kinds:ProviderKind[]=['gemini','nim','openrouter','groq','ollama','compatible'];
const object=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
export function normalizeProvider(value:unknown):ProviderConfig {
  const p=object(value);if(!p||!id(p.id)||!kinds.includes(p.kind as ProviderKind))throw new AiFailure('invalid_output');
  const kind=p.kind as ProviderKind,base=defaults(kind);
  const model=typeof p.model==='string'?p.model.trim().replace(kind==='gemini'?/^models\//:/^$/,''):'';
  if(model.length>160||typeof p.enabled!=='boolean'||p.enabled&&!model)throw new AiFailure('invalid_output');
  const baseUrl=typeof p.baseUrl==='string'&&p.baseUrl.trim()?p.baseUrl.trim().replace(/\/$/,''):base.baseUrl;
  validateEndpoint(kind,baseUrl,(process.env.AI_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean));
  const mode=p.jsonMode??base.jsonMode;if(!['schema','object','prompt'].includes(String(mode)))throw new AiFailure('invalid_output');
  if(!Array.isArray(p.keys)||p.keys.length>20)throw new AiFailure('invalid_output');
  const keys:ProviderKey[]=p.keys.map((value,i)=>{const k=object(value);if(!k||typeof k.value!=='string'||k.value.length>4096||/[\r\n]/.test(k.value)||typeof k.enabled!=='boolean')throw new AiFailure('invalid_key');const keyId=k.id??`${p.id}-key-${i}`;if(!id(keyId))throw new AiFailure('invalid_key');return {id:keyId as string,value:k.value,enabled:k.enabled};});
  if(new Set(keys.map(k=>k.id)).size!==keys.length)throw new AiFailure('invalid_key');
  const priority=Number(p.priority??0),budget=Number(p.maxRequestsPerMinute??20);if(!Number.isInteger(priority)||priority<0||priority>1000||!Number.isInteger(budget)||budget<0||budget>1000)throw new AiFailure('invalid_output');
  return {id:p.id as string,label:typeof p.label==='string'?p.label.slice(0,80):p.id as string,kind,model,baseUrl,enabled:p.enabled,jsonMode:mode as ProviderConfig['jsonMode'],keys,priority,maxRequestsPerMinute:budget};
}
export function providersFromEnvironment():ProviderConfig[] {
  try {
    const raw:unknown=JSON.parse(process.env.AI_PROVIDERS_JSON??'[]');if(!Array.isArray(raw)||raw.length>16)throw new Error('Invalid settings');
    const providers=raw.map(normalizeProvider);
    if(!providers.length&&process.env.GEMINI_API_KEY&&process.env.GEMINI_MODEL)providers.push(normalizeProvider({id:'gemini-env',kind:'gemini',label:'Gemini',model:process.env.GEMINI_MODEL,enabled:true,keys:[{id:'gemini-key',value:process.env.GEMINI_API_KEY,enabled:true}]}));
    if(!providers.length&&process.env.OPENAI_COMPATIBLE_BASE_URL&&process.env.AI_PROVIDER_MODEL)providers.push(normalizeProvider({id:'compatible-env',kind:'compatible',model:process.env.AI_PROVIDER_MODEL,baseUrl:process.env.OPENAI_COMPATIBLE_BASE_URL,enabled:true,keys:[{id:'compatible-key',value:process.env.AI_PROVIDER_KEY??'',enabled:true}]}));
    if(new Set(providers.map(p=>p.id)).size!==providers.length)throw new Error('Duplicate provider');return providers;
  }catch{console.warn('Invalid AI environment configuration; using local policies.');return [];}
}
export function envBudget(name:string,fallback:number){const value=Number(process.env[name]??fallback);return Number.isInteger(value)&&value>=0&&value<=1000000?value:fallback;}
