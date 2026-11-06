import { Router } from 'express';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import { publicSocial } from './context.js';
export function socialRouter(db:WorldDatabase) {
  const router=Router();router.use(requirePlayer(db));
  router.get('/:id',(req,res)=>{const social=publicSocial(db,req.params.id);if(!social){res.status(404).json({error:'Citizen not found'});return;}res.json(social);});
  return router;
}
