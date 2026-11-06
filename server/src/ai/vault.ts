import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync,chmodSync } from 'node:fs';
import { dirname,join } from 'node:path';
import type { WorldDatabase } from '../db/index.js';
export class KeyVault {
  private master:Buffer|undefined;
  constructor(private db:WorldDatabase,private configured=process.env.AI_ENCRYPTION_KEY){}
  private key(){
    if(this.master)return this.master;
    if(this.configured){const key=Buffer.from(this.configured,'base64');if(key.length!==32)throw new Error('Secure key storage unavailable');return this.master=key;}
    if(this.db.name===':memory:')return this.master=randomBytes(32);
    const path=join(dirname(this.db.name),'.ai-encryption-key');
    if(!existsSync(path)){
      if((this.db.prepare('SELECT count(*) n FROM ai_keys').get() as {n:number}).n)throw new Error('Secure key storage unavailable');
      try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('Secure key storage unavailable');}
    }
    const key=readFileSync(path);if(key.length!==32)throw new Error('Secure key storage unavailable');chmodSync(path,0o600);return this.master=key;
  }
  encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');}
  decrypt(value:string){try{const [version,iv,tag,data]=value.split('.');if(version!=='v1'||!iv||!tag||!data)throw new Error('Bad key');const cipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(iv,'base64'));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');}catch{throw new Error('Secure key storage unavailable');}}
}
