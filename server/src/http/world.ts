import { Router } from 'express';
import type { WorldDatabase } from '../db/index.js';
import { PROJECT } from '../../../shared/index.js';
import { MAP_SIZE } from '../../../shared/world.js';
import { requirePlayer } from '../auth/session.js';

export function worldRouter(db: WorldDatabase) {
  const router = Router();
  router.get('/citizens', requirePlayer(db), (_req, res) => {
    const state = db.prepare('SELECT version, tick FROM world WHERE id = 1').get() as { version: number; tick: number };
    const citizens = db.prepare(`SELECT c.id,c.name,c.job,c.x,c.y,c.mood,c.building_id AS buildingId,c.activity,r.direction
      FROM citizens c JOIN citizen_routines r ON r.citizen_id = c.id ORDER BY c.id`).all();
    res.json({ ...state, mapSize: MAP_SIZE, citizens, buildings: db.prepare('SELECT * FROM buildings ORDER BY id').all() });
  });
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
