import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import { RumorError, RumorService } from './service.js';

function objectBody(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return objectBody(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function statusFor(error: unknown): number {
  if (error instanceof RumorError) {
    if (error.code === 'invalid') return 400;
    if (error.code === 'unauthorized') return 401;
    if (error.code === 'not_found') return 404;
    if (error.code === 'conflict') return 409;
  }
  return 503;
}

function messageFor(error: unknown): string {
  if (!(error instanceof RumorError)) return 'Rumors are unavailable.';
  if (error.code === 'unauthorized') return 'Sign in required.';
  if (error.code === 'not_found') return 'Rumor not found.';
  if (error.code === 'conflict') {
    if (error.message === 'stale') return 'This rumor revision is stale.';
    if (error.message === 'immutable') return 'This rumor can no longer be changed.';
    if (error.message === 'changed') return 'Use edit to change the pending rumor.';
    if (error.message === 'pending') return 'A rumor is already pending.';
    if (error.message === 'opportunity') return 'The next rumor opportunity is not available yet.';
    return 'This rumor request conflicts with the current world state.';
  }
  if (error.message === 'text') return 'A safe rumor naming a known citizen or Cairo place is required.';
  return 'Invalid rumor request.';
}

export function rumorRouter(db: WorldDatabase, service?: RumorService) {
  const router = Router();
  router.use(requirePlayer(db));
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (_req, res) => String(res.locals.player.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many rumor changes. Please wait.' }),
  });

  router.get('/', (_req, res) => {
    if (!service) { res.status(503).json({ error: 'Rumors are unavailable.' }); return; }
    try {
      res.json(service.board(String(res.locals.player.id)));
    } catch (error) {
      res.status(statusFor(error)).json({ error: messageFor(error) });
    }
  });

  router.post('/', limiter, (req, res) => {
    if (!service) { res.status(503).json({ error: 'Rumors are unavailable.' }); return; }
    const body = req.body as unknown;
    if (!exactBody(body, ['text']) || typeof body.text !== 'string') {
      res.status(400).json({ error: 'Exactly one text field is required.' }); return;
    }
    try {
      res.json(service.propose(String(res.locals.player.id), body.text));
    } catch (error) {
      res.status(statusFor(error)).json({ error: messageFor(error) });
    }
  });

  router.patch('/:id', limiter, (req, res) => {
    if (!service) { res.status(503).json({ error: 'Rumors are unavailable.' }); return; }
    const body = req.body as unknown;
    if (!exactBody(body, ['revision', 'text']) || typeof body.text !== 'string' ||
        typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) {
      res.status(400).json({ error: 'Exactly revision and text fields are required.' }); return;
    }
    try {
      res.json(service.edit(String(res.locals.player.id), req.params.id, body.revision, body.text));
    } catch (error) {
      res.status(statusFor(error)).json({ error: messageFor(error) });
    }
  });

  router.post('/:id/approve', limiter, (req, res) => {
    if (!service) { res.status(503).json({ error: 'Rumors are unavailable.' }); return; }
    const body = req.body as unknown;
    if (!exactBody(body, ['revision']) || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) {
      res.status(400).json({ error: 'Exactly one revision field is required.' }); return;
    }
    try {
      res.json(service.approve(String(res.locals.player.id), req.params.id, body.revision));
    } catch (error) {
      res.status(statusFor(error)).json({ error: messageFor(error) });
    }
  });

  return router;
}

export const rumorsRouter = rumorRouter;
