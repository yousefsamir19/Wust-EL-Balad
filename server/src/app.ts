import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT, type HealthResponse } from '../../shared/index.js';
import type { WorldDatabase } from './db/index.js';
import { worldRouter } from './http/world.js';
import { authRouter } from './auth/routes.js';
import { sameOrigin } from './auth/session.js';
import { economyRouter } from './economy/routes.js';
import { socialRouter } from './social/routes.js';
import type { AiScheduler } from './ai/scheduler.js';
import { aiRouter } from './ai/routes.js';
import type { RuntimeAiSettings } from './ai/settings.js';
import { streamsRouter,eventStreamRouter } from './streams/index.js';
import type { SimulationClock } from './simulation/clock.js';
import { interrogationRouter } from './interrogation/routes.js';
import type { InterrogationService } from './interrogation/service.js';
import { archivesRouter } from './archives/routes.js';
import { investigationsRouter } from './investigations/routes.js';
import type { InvestigationService } from './investigations/service.js';
import { influenceRouter } from './influence/routes.js';
import type { InfluenceService } from './influence/service.js';
import { rumorsRouter } from './rumors/routes.js';
import type { RumorService } from './rumors/service.js';
import { catchUpRouter } from './catchup/index.js';
import { leaderboardRouter,playerProfilesRouter } from './players/index.js';
import { worldBackupRouter } from './db/backup.js';

export function createApp(clientDirectory = resolve('dist/client'), database?: WorldDatabase, ai?:AiScheduler, aiSettings?:RuntimeAiSettings,services:{clock?:SimulationClock;interrogation?:InterrogationService;investigations?:InvestigationService;influence?:InfluenceService;rumors?:RumorService}={}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/admin/world/restore', express.raw({ type: 'application/vnd.sqlite3', limit: '256mb' }));
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => {
    const health: HealthResponse = { status: 'ok', project: PROJECT };
    res.json(health);
  });
  if (database) {
    app.use('/api', sameOrigin);
    app.use('/api/auth', authRouter(database));
    app.use('/api/admin/world', worldBackupRouter(database));
    app.use('/api/world', worldRouter(database));
    app.use('/api/economy', economyRouter(database));
    app.use('/api/social', socialRouter(database));
    app.use('/api/chats',streamsRouter(database,services.clock));
    app.use('/api/events',eventStreamRouter(database));
    app.use('/api/interrogations',interrogationRouter(database,services.interrogation));
    app.use('/api/archives',archivesRouter(database));
    app.use('/api/investigations',investigationsRouter(database,services.investigations));
    app.use('/api/influence',influenceRouter(database,services.influence));
    app.use('/api/rumors',rumorsRouter(database,services.rumors));
    app.use('/api/catch-up',catchUpRouter(database,services.investigations));
    app.use('/api/leaderboard',leaderboardRouter(database));
    app.use('/api/players',playerProfilesRouter(database));
    if(ai)app.use('/api/admin/ai',aiRouter(database,ai,aiSettings));
  }
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use(express.static(clientDirectory));
  app.get('*', (_req, res) => {
    const index = resolve(clientDirectory, 'index.html');
    if (existsSync(index)) res.sendFile(index);
    else res.status(503).send('Frontend not built. Run npm run build.');
  });
  return app;
}
