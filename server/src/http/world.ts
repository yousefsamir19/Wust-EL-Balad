import { Router } from 'express';
import type { WorldDatabase } from '../db/index.js';
import { PROJECT } from '../../../shared/index.js';

export function worldRouter(db: WorldDatabase) {
  const router = Router();
  router.get('/summary', (_req, res) => {
    const world = db.prepare('SELECT game_time_ms, version, tick FROM world WHERE id = 1').get() as { game_time_ms: number; version: number; tick: number };
    const count = db.prepare('SELECT COUNT(*) AS count FROM citizens').get() as { count: number };
    res.json({
      ...PROJECT, day: Math.floor(world.game_time_ms / 86400000) + 1,
      minute: world.game_time_ms % 86400000 / 60000,
      version: world.version, tick: world.tick, citizenCount: count.count,
      buildings: db.prepare('SELECT id, name, type FROM buildings ORDER BY id').all(),
    });
  });
  return router;
}
