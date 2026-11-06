import { randomUUID } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import type { AiProviderView,AiSettingsView } from '../../../shared/ai.js';
import type { ProviderConfig,ProviderKind,ProviderStatus } from './types.js';
import { normalizeProvider,providersFromEnvironment } from './config.js';
import { defaults } from './transport.js';
import { KeyVault } from './vault.js';
import type { AiScheduler } from './scheduler.js';
interface Row {id:string;name:string;adapter:ProviderKind;model:string;base_url:string;enabled:number;priority:number;config:string}
interface KeyRow {id:string;provider_id:string;label:string;encrypted_key:string;enabled:number;cooldown_until:number;last_error:string|null}
const fields=['label','kind','model','baseUrl','enabled','priority','jsonMode','maxRequestsPerMinute'];
const record=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid settings');return value as Record<string,unknown>;};
export class RuntimeAiSettings {
  private vault:KeyVault;
  constructor(private db:WorldDatabase,private ai:AiScheduler,environment=providersFromEnvironment()) {
    this.vault=new KeyVault(db);try{this.initialize(environment);}catch{console.warn('AI key storage unavailable; using saved/local configuration.');}this.reload();
    const statuses:ProviderStatus[]=[];for(const row of db.prepare('SELECT status FROM ai_provider_status').all() as {status:string}[]){try{statuses.push(JSON.parse(row.status));}catch{/*Corrupt diagnostics are non-authoritative.*/}}
    ai.restoreStatuses(statuses);ai.onStatus(statuses=>this.persistStatus(statuses));
  }
  private initialize(environment:ProviderConfig[]){
    if(this.db.prepare("SELECT value FROM settings WHERE key='ai.initialized'").get())return;
    this.db.transaction(()=>{
      for(const p of environment){this.writeProvider(p);for(const k of p.keys){if(k.value)this.db.prepare('INSERT INTO ai_keys(id,provider_id,encrypted_key,enabled,label) VALUES(?,?,?,?,?)').run(randomUUID(),p.id,this.vault.encrypt(k.value),Number(k.enabled),k.id);}}
      this.db.prepare("INSERT INTO settings(key,value) VALUES('ai.initialized','1')").run();
      if(environment.length)this.audit(null,'import-environment',null,{providers:environment.length});
    })();
  }
  private rows(){return this.db.prepare('SELECT * FROM ai_providers ORDER BY priority,id').all() as Row[];}
  private keyRows(id:string){return this.db.prepare('SELECT * FROM ai_keys WHERE provider_id=? ORDER BY rowid').all(id) as KeyRow[];}
  private readProvider(row:Row):ProviderConfig {const config=JSON.parse(row.config);return normalizeProvider({id:row.id,label:row.name,kind:row.adapter,model:row.model,baseUrl:row.base_url,enabled:!!row.enabled,priority:row.priority,...config,keys:this.keyRows(row.id).map(k=>{let value='';try{value=this.vault.decrypt(k.encrypted_key);if(k.last_error==='key_unavailable')this.db.prepare('UPDATE ai_keys SET last_error=NULL WHERE id=?').run(k.id);}catch{this.db.prepare("UPDATE ai_keys SET last_error='key_unavailable' WHERE id=?").run(k.id);}return {id:k.id,value,enabled:!!k.enabled};})});}
  private active(){return (this.db.prepare("SELECT value FROM settings WHERE key='ai.active_provider'").get() as {value:string}|undefined)?.value||null;}
  private reload(){const providers:ProviderConfig[]=[];for(const row of this.rows()){try{providers.push(this.readProvider(row));}catch{/*Invalid saved providers must not stop the town.*/}}this.ai.updateProviders(providers,this.active());}
  private refresh(){this.reload();try{this.persistStatus(this.ai.statuses());}catch{/*Diagnostics cannot invalidate committed settings.*/}}
  private writeProvider(p:ProviderConfig){this.db.prepare(`INSERT INTO ai_providers(id,name,adapter,model,base_url,enabled,priority,config) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,adapter=excluded.adapter,model=excluded.model,base_url=excluded.base_url,enabled=excluded.enabled,priority=excluded.priority,config=excluded.config`).run(p.id,p.label,p.kind,p.model,p.baseUrl,Number(p.enabled),p.priority,JSON.stringify({jsonMode:p.jsonMode,maxRequestsPerMinute:p.maxRequestsPerMinute}));}
  private audit(adminId:string|null,action:string,providerId:string|null,details:Record<string,unknown>){this.db.prepare('INSERT INTO ai_audit(admin_id,action,provider_id,details,created_at) VALUES(?,?,?,?,?)').run(adminId,action,providerId,JSON.stringify(details),new Date().toISOString());}
  private persistStatus(statuses:ProviderStatus[]){if(!this.db.open)return;this.db.transaction(()=>{for(const status of statuses){if(!this.db.prepare('SELECT id FROM ai_providers WHERE id=?').get(status.id))continue;this.db.prepare('INSERT INTO ai_provider_status VALUES(?,?) ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status').run(status.id,JSON.stringify(status));for(const key of status.keys)this.db.prepare('UPDATE ai_keys SET cooldown_until=?,last_error=? WHERE id=? AND provider_id=?').run(key.cooldownUntil,key.lastError,key.id,status.id);}})();}
  private existing(id:string){const row=this.db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id) as Row|undefined;if(!row)throw new Error('Provider not found');return this.readProvider(row);}
  view():AiSettingsView {
    const statuses=new Map(this.ai.statuses().map(s=>[s.id,s]));
    const providers:AiProviderView[]=this.rows().map(row=>{const config=JSON.parse(row.config),s=statuses.get(row.id);return {id:row.id,label:row.name,kind:row.adapter,model:row.model,baseUrl:row.base_url,enabled:!!row.enabled,priority:row.priority,jsonMode:config.jsonMode??defaults(row.adapter).jsonMode,maxRequestsPerMinute:config.maxRequestsPerMinute??20,keys:this.keyRows(row.id).map(k=>{const status=s?.keys.find(x=>x.id===k.id);return {id:k.id,label:k.label,enabled:!!k.enabled,configured:!!k.encrypted_key,cooldownUntil:status?.cooldownUntil??k.cooldown_until,lastError:k.last_error==='key_unavailable'?k.last_error:status?.lastError??k.last_error};}),status:{cooldownUntil:s?.cooldownUntil??0,lastError:s?.lastError??null,lastSuccess:s?.lastSuccess??null,requests:s?.requests??0,inputTokens:s?.inputTokens??0,outputTokens:s?.outputTokens??0}};});
    const kinds:ProviderKind[]=['gemini','nim','openrouter','groq','ollama','compatible'];const queue=this.ai.summary();
    return {providers,activeProviderId:this.active(),defaults:Object.fromEntries(kinds.map(kind=>[kind,defaults(kind)])) as AiSettingsView['defaults'],queue:{active:queue.active,queued:queue.queued,localFallbacks:queue.localFallbacks,activePlayers:queue.activePlayers},audit:(this.db.prepare('SELECT id,action,provider_id,details,created_at FROM ai_audit ORDER BY id DESC LIMIT 20').all() as {id:number;action:string;provider_id:string|null;details:string;created_at:string}[]).map(r=>({id:r.id,action:r.action,providerId:r.provider_id,createdAt:r.created_at,details:JSON.parse(r.details)}))};
  }
  saveProvider(admin:string,id:string|undefined,input:unknown){const body=record(input);if(Object.keys(body).some(k=>!fields.includes(k)))throw new Error('Invalid settings');const old=id?this.existing(id):undefined;const p=normalizeProvider({...old,...body,id:id??randomUUID(),keys:old?.keys??[]});if(!p.label.trim())throw new Error('Invalid settings');if(!old&&(this.db.prepare('SELECT count(*) n FROM ai_providers').get() as {n:number}).n>=16)throw new Error('Provider limit');const changed=!!old&&(old.kind!==p.kind||new URL(old.baseUrl).origin!==new URL(p.baseUrl).origin);
    this.db.transaction(()=>{this.writeProvider(p);if(changed)this.db.prepare('UPDATE ai_keys SET enabled=0 WHERE provider_id=?').run(p.id);this.audit(admin,old?'edit-provider':'add-provider',p.id,{kind:p.kind,model:p.model,baseUrl:p.baseUrl,enabled:p.enabled,priority:p.priority,jsonMode:p.jsonMode,keysDisabled:changed});})();this.refresh();
  }
  removeProvider(admin:string,id:string){if(!this.hasProvider(id))throw new Error('Provider not found');this.db.transaction(()=>{this.db.prepare('DELETE FROM ai_providers WHERE id=?').run(id);if(this.active()===id)this.db.prepare("DELETE FROM settings WHERE key='ai.active_provider'").run();this.audit(admin,'remove-provider',id,{});})();this.refresh();}
  setActive(admin:string,input:unknown){const body=record(input),id=body.providerId;if(id!==null&&typeof id!=='string')throw new Error('Invalid settings');if(typeof id==='string')this.existing(id);this.db.transaction(()=>{if(id===null)this.db.prepare("DELETE FROM settings WHERE key='ai.active_provider'").run();else this.db.prepare("INSERT INTO settings VALUES('ai.active_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);this.audit(admin,'select-active',id as string|null,{});})();this.refresh();}
  saveKey(admin:string,providerId:string,keyId:string|undefined,input:unknown){this.existing(providerId);const body=record(input);if(Object.keys(body).some(k=>!['label','value','enabled'].includes(k)))throw new Error('Invalid settings');const old=keyId?this.keyRows(providerId).find(k=>k.id===keyId):undefined;if(keyId&&!old)throw new Error('Key not found');const label=body.label??old?.label??'Key',enabled=body.enabled??!!(old?.enabled??1);if(typeof label!=='string'||!label.trim()||label.length>80||typeof enabled!=='boolean')throw new Error('Invalid settings');
    const value=body.value;if((!old||value!==undefined)&&(typeof value!=='string'||!value.trim()||value.length>4096||/[\r\n]/.test(value)))throw new Error('Invalid settings');if(!old&&this.keyRows(providerId).length>=20)throw new Error('Key limit');const id=keyId??randomUUID(),encrypted=value===undefined?old!.encrypted_key:this.vault.encrypt(value as string);
    this.db.transaction(()=>{this.db.prepare('INSERT INTO ai_keys(id,provider_id,encrypted_key,enabled,label) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,enabled=excluded.enabled,label=excluded.label').run(id,providerId,encrypted,Number(enabled),label);if(value!==undefined||enabled)this.db.prepare('UPDATE ai_keys SET last_error=NULL,cooldown_until=0,failures=0 WHERE id=?').run(id);this.audit(admin,old?'edit-key':'add-key',providerId,{keyId:id,label,enabled,replaced:value!==undefined});})();this.reload();if(value!==undefined||enabled)this.ai.resetKeyBackoff(providerId,id);this.persistStatus(this.ai.statuses());
  }
  removeKey(admin:string,providerId:string,keyId:string){if(!this.keyRows(providerId).some(k=>k.id===keyId))throw new Error('Key not found');this.db.transaction(()=>{this.db.prepare('DELETE FROM ai_keys WHERE id=? AND provider_id=?').run(keyId,providerId);this.audit(admin,'remove-key',providerId,{keyId});})();this.refresh();}
  hasProvider(id:string){return !!this.db.prepare('SELECT id FROM ai_providers WHERE id=?').get(id);}
  recordTest(admin:string,id:string,source:string,reason:string|null){this.audit(admin,'connection-test',id,{source,reason});}
}
