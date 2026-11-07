import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { initializeRoutines } from '../citizens/routines.js';
import { initializeEconomy } from '../economy/initialize.js';
import { initializeSocial } from '../social/initialize.js';

export type WorldDatabase = Database.Database;
export function openWorld(url = process.env.DATABASE_URL ?? 'file:./data/world.db'): WorldDatabase {
  const name = url.startsWith('file:') ? url.slice(5) : url;
  if (!name) throw new Error('DATABASE_URL must name a SQLite file.');
  const path = name === ':memory:' ? name : resolve(name);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // A validated admin restore is activated only at process startup, when no
  // connection or WAL from the previous database can still be in use.
  if (path !== ':memory:' && existsSync(`${path}.restore`)) {
    if (existsSync(path)) {
      const previous = new Database(path);
      try { previous.pragma('wal_checkpoint(TRUNCATE)'); }
      finally { previous.close(); }
    }
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    if (existsSync(path)) copyFileSync(path, `${path}.pre-restore-${Date.now()}`, 1);
    rmSync(path, { force: true });
    try { renameSync(`${path}.restore`, path); }
    catch {
      // Windows can refuse renaming SQLite files even after all handles close.
      // The staged source remains intact if copying fails, so startup can retry.
      copyFileSync(`${path}.restore`, path, 1);
      rmSync(`${path}.restore`, { force: true });
    }
  }
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    seed(db);
    db.transaction(() => initializeRoutines(db))();
    db.transaction(() => initializeEconomy(db))();
    db.transaction(() => initializeSocial(db))();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function worldDatabasePath(url = process.env.DATABASE_URL ?? 'file:./data/world.db') {
  const name = url.startsWith('file:') ? url.slice(5) : url;
  if (!name || name === ':memory:') throw new Error('A file-backed DATABASE_URL is required for backups.');
  return resolve(name);
}
