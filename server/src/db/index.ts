import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { initializeRoutines } from '../citizens/routines.js';
import { initializeEconomy } from '../economy/initialize.js';

export type WorldDatabase = Database.Database;
export function openWorld(url = process.env.DATABASE_URL ?? 'file:./data/world.db'): WorldDatabase {
  const name = url.startsWith('file:') ? url.slice(5) : url;
  if (!name) throw new Error('DATABASE_URL must name a SQLite file.');
  const path = name === ':memory:' ? name : resolve(name);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
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
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
