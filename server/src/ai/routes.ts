import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import { requireAdmin } from '../auth/session.js';
import type { AiScheduler } from './scheduler.js';
import type { RuntimeAiSettings } from './settings.js';
const readyTask=(providerId?:string)=>({id:randomUUID(),purpose:'provider-test',providerId,system:'Return only JSON with ready:true.',prompt:'Test structured response availability.',schema:{type:'object',properties:{ready:{type:'boolean'}},required:['ready'],additionalProperties:false},parse:(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as {ready?:unknown}).ready!==true)throw new Error('Invalid response');return {ready:true};},fallback:()=>({ready:true}),urgent:true,maxOutputTokens:64});
export function aiRouter(db:WorldDatabase,ai:AiScheduler,settings?:RuntimeAiSettings) {
  const router=Router();router.use(requireAdmin(db));
  router.get('/status',(_req,res)=>res.json(ai.summary()));
  const tests=rateLimit({windowMs:60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many provider tests'}});
  router.post('/test',tests,async(_req,res)=>{try{res.json(await ai.runDetailed(readyTask()));}catch{res.status(503).json({error:'Provider test failed'});}});
  if(settings){
    const changes=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many settings changes'}});
    router.get('/providers',(_req,res)=>res.json(settings.view()));
    const mutate=(operation:(admin:string,params:Record<string,string>,body:unknown)=>void):import('express').RequestHandler=>(req,res)=>{try{operation(res.locals.player.id,req.params,req.body);res.json(settings.view());}catch{res.status(400).json({error:'Invalid settings or unavailable secure key storage'});}};
    router.post('/providers',changes,mutate((admin,_params,body)=>settings.saveProvider(admin,undefined,body)));
    router.patch('/providers/:id',changes,mutate((admin,p,body)=>settings.saveProvider(admin,p.id,body)));
    router.delete('/providers/:id',changes,mutate((admin,p)=>settings.removeProvider(admin,p.id)));
    router.put('/active',changes,mutate((admin,_p,body)=>settings.setActive(admin,body)));
    router.post('/providers/:id/keys',changes,mutate((admin,p,body)=>settings.saveKey(admin,p.id,undefined,body)));
    router.patch('/providers/:id/keys/:keyId',changes,mutate((admin,p,body)=>settings.saveKey(admin,p.id,p.keyId,body)));
    router.delete('/providers/:id/keys/:keyId',changes,mutate((admin,p)=>settings.removeKey(admin,p.id,p.keyId)));
    router.post('/providers/:id/test',tests,async(req,res)=>{if(!settings.hasProvider(req.params.id)){res.status(404).json({error:'Provider not found'});return;}try{const result=await ai.runDetailed(readyTask(req.params.id));settings.recordTest(res.locals.player.id,req.params.id,result.source,result.reason);res.json(result);}catch{res.status(503).json({error:'Provider test failed'});}});
  }
  return router;
}
