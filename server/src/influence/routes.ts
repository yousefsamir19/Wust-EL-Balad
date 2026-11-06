import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import { InfluenceError, InfluenceService } from './service.js';
import type { InterventionStrength } from '../../../shared/influence.js';

const strengths: readonly InterventionStrength[] = ['subtle', 'medium', 'strong'];

function validObjectBody(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorStatus(error: unknown): number {
  if (error instanceof InfluenceError) {
    if (error.code === 'invalid') return 400;
    if (error.code === 'unauthorized') return 401;
    if (error.code === 'conflict') return 409;
  }
  return 503;
}

function errorMessage(error: unknown): string {
  if (error instanceof InfluenceError) {
    if (error.code === 'unauthorized') return 'Sign in required.';
    if (error.code === 'conflict') return error.message === 'changed'
      ? 'This intervention cannot be changed.'
      : 'This intervention request conflicts with the current world state.';
    if (error.message === 'insufficient balance') return 'Insufficient influence balance.';
    if (error.message === 'citizen') return 'Citizen not found.';
    if (error.message === 'suggestion') return 'A safe suggestion of 1–280 characters is required.';
    if (error.message === 'strength') return 'A valid intervention strength is required.';
  }
  return 'Influence is unavailable.';
}

export function influenceRouter(db: WorldDatabase, service?: InfluenceService) {
  const router = Router();
  router.use(requirePlayer(db));
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (_req, res) => String(res.locals.player.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many interventions. Please wait.' }),
  });

  router.get('/', (_req, res) => {
    if (!service) { res.status(503).json({ error: 'Influence is unavailable.' }); return; }
    try {
      res.json(service.wallet(String(res.locals.player.id)));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  router.post('/interventions', limiter, (req, res) => {
    if (!service) { res.status(503).json({ error: 'Influence is unavailable.' }); return; }
    const body = req.body as unknown;
    if (!validObjectBody(body) || Object.keys(body).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(body, 'citizenId') ||
      !Object.prototype.hasOwnProperty.call(body, 'strength') ||
      !Object.prototype.hasOwnProperty.call(body, 'suggestion') ||
      typeof body.citizenId !== 'string' ||
      typeof body.strength !== 'string' || !strengths.includes(body.strength as InterventionStrength) ||
      typeof body.suggestion !== 'string') {
      res.status(400).json({ error: 'citizenId, strength, and a safe suggestion are required.' });
      return;
    }
    try {
      res.json(service.submit(
        String(res.locals.player.id),
        body.citizenId,
        body.strength as InterventionStrength,
        body.suggestion,
      ));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  return router;
}
