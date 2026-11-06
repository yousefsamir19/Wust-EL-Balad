import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { WorldDatabase } from '../db/index.js';
import { requirePlayer } from '../auth/session.js';
import { InvestigationError, InvestigationService } from './service.js';

function parseDay(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const day = Number(value);
  return Number.isSafeInteger(day) && day >= 1 ? day : undefined;
}

function errorStatus(error: unknown): number {
  if (error instanceof InvestigationError) {
    if (error.code === 'invalid') return 400;
    if (error.code === 'not_found') return 404;
    if (error.code === 'unauthorized') return 401;
    if (error.code === 'conflict') return 409;
    return 503;
  }
  return 503;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof InvestigationError)) return 'Investigations are unavailable.';
  if (error.code === 'invalid') return 'Invalid investigation request.';
  if (error.code === 'not_found') return 'Investigation day not found.';
  if (error.code === 'unauthorized') return 'Sign in required.';
  if (error.message === 'changed') return 'This investigation answer cannot be changed.';
  if (error.message === 'alreadyfinal') return 'This investigation is already finalized.';
  return 'Investigations are unavailable.';
}

function validObjectBody(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function investigationsRouter(db: WorldDatabase, service?: InvestigationService) {
  const router = Router();
  router.use(requirePlayer(db));
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (_req, res) => String(res.locals.player.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many investigation submissions. Please wait.' }),
  });

  router.get('/', (_req, res) => {
    if (!service) { res.status(503).json({ error: 'Investigations are unavailable.' }); return; }
    try {
      res.json({ days: service.list(String(res.locals.player.id)) });
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  router.get('/:day', (req, res) => {
    if (!service) { res.status(503).json({ error: 'Investigations are unavailable.' }); return; }
    const day = parseDay(req.params.day);
    if (day === undefined) { res.status(400).json({ error: 'A valid investigation day is required.' }); return; }
    try {
      res.json(service.view(String(res.locals.player.id), day));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  router.post('/:day', limiter, async (req, res) => {
    if (!service) { res.status(503).json({ error: 'Investigations are unavailable.' }); return; }
    const day = parseDay(req.params.day);
    const body = req.body as unknown;
    if (day === undefined || !validObjectBody(body) || Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'answer') ||
      typeof body.answer !== 'string' || !body.answer.trim() || body.answer.trim().length > 4000 ||
      Array.from(body.answer).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 && !['\t', '\n', '\r'].includes(character);
      })) {
      res.status(400).json({ error: 'An answer of 1–4000 characters is required.' });
      return;
    }
    try {
      res.json(await service.submit(String(res.locals.player.id), day, body.answer));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  router.post('/:day/skip', limiter, (req, res) => {
    if (!service) { res.status(503).json({ error: 'Investigations are unavailable.' }); return; }
    const day = parseDay(req.params.day);
    const body = req.body as unknown;
    if (day === undefined || !validObjectBody(body) || Object.keys(body).length !== 0) {
      res.status(400).json({ error: 'An empty request body is required.' });
      return;
    }
    try {
      res.json(service.skip(String(res.locals.player.id), day));
    } catch (error) {
      res.status(errorStatus(error)).json({ error: errorMessage(error) });
    }
  });

  return router;
}
