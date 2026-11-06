import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT, type HealthResponse } from '../../shared/index.js';
import type { WorldDatabase } from './db/index.js';
import { worldRouter } from './http/world.js';
import { authRouter } from './auth/routes.js';
import { sameOrigin } from './auth/session.js';

export function createApp(clientDirectory = resolve('dist/client'), database?: WorldDatabase) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => {
    const health: HealthResponse = { status: 'ok', project: PROJECT };
    res.json(health);
  });
  if (database) {
    app.use('/api', sameOrigin);
    app.use('/api/auth', authRouter(database));
    app.use('/api/world', worldRouter(database));
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
