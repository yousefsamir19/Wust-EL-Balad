import { Router,type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { WorldDatabase } from '../db/index.js';
import type { SimulationClock } from '../simulation/clock.js';
import { requirePlayer } from '../auth/session.js';
import type { CharacterMessage,ImportantEvent,ObserverMessage,StreamPage } from '../../../shared/chats.js';
interface PageQuery {cursor:number|null;forward:boolean;limit:number}
function pageQuery(req:Request):PageQuery {
  if(req.query.before!==undefined&&req.query.after!==undefined)throw new Error('Use one cursor');
  const value=req.query.before??req.query.after,limit=req.query.limit===undefined?40:Number(req.query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100||req.query.limit!==undefined&&typeof req.query.limit!=='string')throw new Error('Invalid limit');
  if(value!==undefined&&(typeof value!=='string'||!value.trim()||!Number.isSafeInteger(Number(value))||Number(value)<0))throw new Error('Invalid cursor');
  return {cursor:value===undefined?null:Number(value),forward:req.query.after!==undefined,limit};
}
function selectPage<T extends {id:number}>(db:WorldDatabase,sql:string,condition:string,args:unknown[],q:PageQuery,alias:string):StreamPage<T>{
  const cursor=q.cursor===null?'':` AND ${alias}.id ${q.forward?'>':'<'} ?`,rows=db.prepare(`${sql} WHERE ${condition}${cursor} ORDER BY ${alias}.id ${q.forward?'ASC':'DESC'} LIMIT ?`).all(...args,...(q.cursor===null?[]:[q.cursor]),q.limit+1) as T[];
  const hasMore=rows.length>q.limit,items=rows.slice(0,q.limit);if(!q.forward)items.reverse();return {items,hasMore,olderCursor:!q.forward&&hasMore?items[0].id:null};
}
const observerSql=`SELECT m.id,m.player_id AS playerId,p.username,p.avatar,m.text,m.created_at AS createdAt,m.game_time_ms AS gameTimeMs,CAST(m.game_time_ms/86400000 AS INTEGER)+1 AS day FROM observer_messages m JOIN players p ON p.id=m.player_id`;
export function observerMessage(db:WorldDatabase,id:number):ObserverMessage{return db.prepare(`${observerSql} WHERE m.id=?`).get(id) as ObserverMessage;}
export function streamsRouter(db:WorldDatabase,clock?:SimulationClock){
  const router=Router();router.use(requirePlayer(db));
  router.get('/observer',(req,res)=>{try{res.json(selectPage<ObserverMessage>(db,observerSql,'1=1',[],pageQuery(req),'m'));}catch{res.status(400).json({error:'Invalid pagination'});}});
  const limiter=rateLimit({windowMs:60000,limit:20,keyGenerator:(_req,res)=>String(res.locals.player.id),standardHeaders:'draft-8',legacyHeaders:false,handler:(_req,res)=>res.status(429).json({error:'Too many messages. Please wait.'})});
  router.post('/observer',limiter,(req,res)=>{
    const body=req.body as Record<string,unknown>|undefined;if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['text','commandId'].includes(k))||typeof body.text!=='string'||!body.text.trim()||body.text.trim().length>1000||Array.from(body.text).some(c=>c.charCodeAt(0)<32&&!['\t','\n','\r'].includes(c))||body.commandId!==undefined&&(typeof body.commandId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(body.commandId))){res.status(400).json({error:'A message of 1–1000 characters is required'});return;}
    if(!clock){res.status(503).json({error:'World writer unavailable'});return;}
    const playerId=String(res.locals.player.id),text=body.text.trim(),id=`observer:${playerId}:${body.commandId??randomUUID()}`;
    try{const row=clock.commitCommand(id,(db,state)=>{const result=db.prepare('INSERT INTO observer_messages(player_id,text,created_at,game_time_ms) VALUES(?,?,?,?)').run(playerId,text,new Date().toISOString(),state.game_time_ms);return observerMessage(db,Number(result.lastInsertRowid));});if(row.text!==text){res.status(409).json({error:'This command id was already used for a different message'});return;}res.status(201).json(row);}catch{res.status(503).json({error:'Message could not be committed'});}
  });
  router.get('/characters/:id',(req,res)=>{
    if(!db.prepare('SELECT id FROM citizens WHERE id=?').get(req.params.id)){res.status(404).json({error:'Citizen not found'});return;}
    const sql=`SELECT m.id,m.game_time_ms AS gameTimeMs,CAST(m.game_time_ms/86400000 AS INTEGER)+1 AS day,m.speaker_id AS speakerId,s.name AS speakerName,m.recipient_id AS recipientId,r.name AS recipientName,m.text,m.visibility FROM conversations m JOIN citizens s ON s.id=m.speaker_id JOIN citizens r ON r.id=m.recipient_id`;
    try{res.json(selectPage<CharacterMessage>(db,sql,'(m.speaker_id=? OR m.recipient_id=?)',[req.params.id,req.params.id],pageQuery(req),'m'));}catch{res.status(400).json({error:'Invalid pagination'});}
  });
  return router;
}
export function eventStreamRouter(db:WorldDatabase){const router=Router();router.use(requirePlayer(db));router.get('/',(req,res)=>{
  const sql=`SELECT e.id,e.game_time_ms AS gameTimeMs,e.type,e.actor_id AS actorId,e.target,e.amount,e.importance,COALESCE(a.name,'Town') AS actorName,COALESCE(t.name,b.name,'') AS targetName,CASE WHEN json_type(e.details,'$.text')='text' THEN json_extract(e.details,'$.text') END AS text FROM events e LEFT JOIN citizens a ON a.id=e.actor_id LEFT JOIN citizens t ON t.id=e.target LEFT JOIN buildings b ON b.id=e.target`;
  try{res.json(selectPage<ImportantEvent>(db,sql,"e.visibility='public' AND e.importance>=50",[],pageQuery(req),'e'));}catch{res.status(400).json({error:'Invalid pagination'});}
});return router;}
