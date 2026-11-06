export type AiProviderKind='gemini'|'nim'|'openrouter'|'groq'|'ollama'|'compatible';
export type AiJsonMode='schema'|'object'|'prompt';
export interface AiKeyView {id:string;label:string;enabled:boolean;configured:boolean;cooldownUntil:number;lastError:string|null}
export interface AiProviderView {id:string;label:string;kind:AiProviderKind;model:string;baseUrl:string;enabled:boolean;priority:number;jsonMode:AiJsonMode;maxRequestsPerMinute:number;keys:AiKeyView[];status:{cooldownUntil:number;lastError:string|null;lastSuccess:number|null;requests:number;inputTokens:number;outputTokens:number}}
export interface AiSettingsView {activeProviderId:string|null;providers:AiProviderView[];defaults:Record<AiProviderKind,{baseUrl:string;jsonMode:AiJsonMode}>;queue:{active:number;queued:number;localFallbacks:number;activePlayers:number};audit:{id:number;action:string;providerId:string|null;createdAt:string;details:Record<string,unknown>}[]}
export type AiProviderEdit=Omit<AiProviderView,'id'|'keys'|'status'>;
export interface AiConnectionResult {value:{ready:boolean};source:'network'|'local';providerId:string|null;reason:string|null}
