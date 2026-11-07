import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openWorld } from '../server/src/db/index.js';

test('online SQLite export is consistent and staged restore activates on restart while retaining the old database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wust-backup-'));
  const path = join(dir, 'world.db');
  try {
    let db = openWorld(`file:${path}`);
    db.prepare("INSERT INTO settings(key,value) VALUES('backup-test','before') ON CONFLICT(key) DO UPDATE SET value='before'").run();
    const exportPath = join(dir, 'export.sqlite');
    await db.backup(exportPath);
    const exported = readFileSync(exportPath);
    db.prepare("UPDATE settings SET value='after' WHERE key='backup-test'").run();
    writeFileSync(`${path}.restore`, exported, { flag: 'wx' });
    db.close();

    db = openWorld(`file:${path}`);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='backup-test'").get() as { value: string }).value, 'before');
    assert.ok(readdirSync(dir).some((name) => name.startsWith('world.db.pre-restore-')));
    assert.equal(existsSync(`${path}.restore`), false);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
