import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import type { WorldDatabase } from '../db/index.js';
import { requireAdmin } from '../auth/session.js';
import type { AiScheduler } from './scheduler.js';
export function aiRouter(db:WorldDatabase,ai:AiScheduler) {
  const router=Router();router.use(requireAdmin(db));
  router.get('/status',(_req,res)=>res.json(ai.summary()));
  router.post('/test',rateLimit({windowMs:60000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many provider tests'}}),async(_req,res)=>{
    try {const result=await ai.runDetailed({id:randomUUID(),purpose:'provider-test',system:'Return only JSON with ready:true.',prompt:'Test structured response availability.',schema:{type:'object',properties:{ready:{type:'boolean'}},required:['ready'],additionalProperties:false},parse:value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as {ready?:unknown}).ready!==true)throw new Error('Invalid response');return {ready:true};},fallback:()=>({ready:true}),urgent:true,maxOutputTokens:64});res.json(result);}catch{res.status(503).json({error:'Provider test failed'});}
  });return router;
}
