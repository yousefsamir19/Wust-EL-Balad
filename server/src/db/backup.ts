import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { requireAdmin } from '../auth/session.js';
import type { WorldDatabase } from './index.js';
import { worldDatabasePath } from './index.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';

export function worldBackupRouter(db: WorldDatabase) {
  const router = Router();
  router.use(requireAdmin(db));
  router.get('/export', async (_req, res, next) => {
    const target = join(dirname(worldDatabasePath()), `.world-backup-${randomUUID()}.sqlite`);
    try {
      await db.backup(target);
      res.download(target, 'wust-el-balad-world.sqlite', (error) => {
        rmSync(target, { force: true });
        if (error && !res.headersSent) next(error);
      });
    } catch (error) { rmSync(target, { force: true }); next(error); }
  });
  router.post('/restore', (req: Request, res: Response, next) => {
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 100 || data.length > 256 * 1024 * 1024) {
      res.status(400).json({ error: 'Upload a SQLite backup using application/vnd.sqlite3 (max 256 MiB).' }); return;
    }
    const path = worldDatabasePath();
    const staged = `${path}.restore`;
    const validation = `${path}.validate-${randomUUID()}`;
    try {
      if (existsSync(staged)) { res.status(409).json({ error: 'A restore is already staged.' }); return; }
      writeFileSync(validation, data, { flag: 'wx', mode: 0o600 });
      const candidate = new Database(validation, { readonly: true, fileMustExist: true });
      try {
        const integrity = candidate.pragma('integrity_check', { simple: true });
        const version = candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
        const world = candidate.prepare('SELECT id FROM world WHERE id=1').get();
        if (integrity !== 'ok' || !world || !version.version || version.version > CURRENT_SCHEMA_VERSION) throw new Error('Backup integrity or schema version is invalid.');
      } finally { candidate.close(); }
      // Keep the active file untouched. Startup atomically activates this after
      // the host restarts the service; the old database is retained as .pre-restore.
      const pending = `${staged}.${randomUUID()}.tmp`;
      copyFileSync(validation, pending, 1);
      try { renameSync(pending, staged); }
      catch (error) { rmSync(pending, { force: true }); throw error; }
      res.status(202).json({ staged: true, restartRequired: true, message: 'Restore staged. Restart the server to activate it; the previous database is retained as .pre-restore.' });
    } catch (error) { next(error); }
    finally { rmSync(validation, { force: true }); }
  });
  return router;
}
