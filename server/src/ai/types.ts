export type ProviderKind='gemini'|'nim'|'openrouter'|'groq'|'ollama'|'compatible';
export type JsonMode='schema'|'object'|'prompt';
export interface ProviderKey {id:string;value:string;enabled:boolean}
export interface ProviderConfig {id:string;label:string;kind:ProviderKind;model:string;baseUrl:string;enabled:boolean;priority:number;jsonMode:JsonMode;keys:ProviderKey[];maxRequestsPerMinute?:number}
export type JsonSchema=Record<string,unknown>;
export type AiFailureCode='invalid_key'|'rate_limited'|'server_error'|'network_error'|'timeout'|'invalid_output'|'validation_error'|'budget_exhausted'|'disabled'|'unsafe_endpoint';
export class AiFailure extends Error {
  constructor(public code:AiFailureCode,public retryAfterMs=0){super(code);}
}
export interface WireRequest {system:string;prompt:string;schema:JsonSchema;maxOutputTokens:number}
export interface WireResult {value:unknown;inputTokens:number;outputTokens:number}
export type Transport=(provider:ProviderConfig,key:ProviderKey|undefined,request:WireRequest,signal:AbortSignal)=>Promise<WireResult>;
export interface AiTask<T> {id:string;purpose:string;system:string;prompt:string;schema:JsonSchema;parse:(value:unknown)=>T;fallback:()=>T;actorId?:string;providerId?:string;urgent?:boolean;batchable?:boolean;maxOutputTokens?:number;timeoutMs?:number}
export interface AiResult<T> {value:T;source:'network'|'local';providerId:string|null;reason:AiFailureCode|null}
export interface ProviderStatus {id:string;cooldownUntil:number;ownCooldownUntil?:number;quotaCooldownUntil?:number;lastError:AiFailureCode|null;lastSuccess:number|null;requests:number;inputTokens:number;outputTokens:number;keys:{id:string;cooldownUntil:number;lastError:AiFailureCode|null}[]}
