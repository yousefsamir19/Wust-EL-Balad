import { Router } from 'express';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
export function economyRouter(db:WorldDatabase) {
  const router=Router();router.use(requirePlayer(db));
  router.get('/:id',(req,res)=>{
    const citizen=db.prepare('SELECT id,money,job,workplace_id FROM citizens WHERE id=?').get(req.params.id);
    if(!citizen){res.status(404).json({error:'Citizen not found'});return;}
    const savings=db.prepare('SELECT balance FROM bank_accounts WHERE citizen_id=?').get(req.params.id) as {balance:number};
    res.json({citizen,savings:savings.balance,debts:db.prepare('SELECT id,lender_account,outstanding,due_day,kind FROM debts WHERE borrower_account=? AND outstanding>0').all(`citizen:${req.params.id}`),transactions:db.prepare(`SELECT t.id,t.amount,t.type,t.event_id,t.game_time_ms,t.from_account,t.to_account FROM money_transactions t JOIN events e ON e.id=t.event_id WHERE e.visibility='public' AND (t.from_account=? OR t.to_account=?) ORDER BY t.game_time_ms DESC LIMIT 40`).all(`citizen:${req.params.id}`,`citizen:${req.params.id}`)});
  });
  return router;
}
