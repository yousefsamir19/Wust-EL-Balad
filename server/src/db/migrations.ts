import type Database from 'better-sqlite3';

const migrations = [{ version: 1, sql: `
CREATE TABLE world (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  game_time_ms INTEGER NOT NULL DEFAULT 28800000 CHECK (game_time_ms >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  tick INTEGER NOT NULL DEFAULT 0 CHECK (tick >= 0),
  seed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE buildings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  door_x INTEGER NOT NULL, door_y INTEGER NOT NULL
);
CREATE TABLE citizens (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, job TEXT NOT NULL,
  money INTEGER NOT NULL CHECK (money >= 0),
  personality TEXT NOT NULL CHECK (json_valid(personality)),
  goals TEXT NOT NULL CHECK (json_valid(goals)),
  needs TEXT NOT NULL CHECK (json_valid(needs)),
  mood TEXT NOT NULL, reputation INTEGER NOT NULL DEFAULT 50,
  x INTEGER NOT NULL, y INTEGER NOT NULL,
  home_id TEXT NOT NULL REFERENCES buildings(id),
  workplace_id TEXT REFERENCES buildings(id), building_id TEXT REFERENCES buildings(id),
  activity TEXT NOT NULL, thoughts TEXT NOT NULL,
  appearance TEXT NOT NULL CHECK (json_valid(appearance))
);
CREATE TABLE relationships (
  citizen_id TEXT NOT NULL REFERENCES citizens(id), other_id TEXT NOT NULL REFERENCES citizens(id),
  trust INTEGER NOT NULL CHECK (trust BETWEEN 0 AND 100),
  affection INTEGER NOT NULL CHECK (affection BETWEEN 0 AND 100),
  respect INTEGER NOT NULL CHECK (respect BETWEEN 0 AND 100),
  fear INTEGER NOT NULL DEFAULT 0 CHECK (fear BETWEEN 0 AND 100),
  debt INTEGER NOT NULL DEFAULT 0 CHECK (debt >= 0),
  grudge INTEGER NOT NULL DEFAULT 0 CHECK (grudge BETWEEN 0 AND 100),
  suspicion INTEGER NOT NULL DEFAULT 0 CHECK (suspicion BETWEEN 0 AND 100),
  dependence INTEGER NOT NULL DEFAULT 0 CHECK (dependence BETWEEN 0 AND 100),
  PRIMARY KEY (citizen_id, other_id), CHECK (citizen_id != other_id)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_version INTEGER NOT NULL, game_time_ms INTEGER NOT NULL,
  type TEXT NOT NULL, actor_id TEXT REFERENCES citizens(id), target TEXT,
  amount INTEGER, importance INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  details TEXT NOT NULL CHECK (json_valid(details)),
  cause_id INTEGER REFERENCES events(id)
);
CREATE INDEX events_time ON events(game_time_ms, id);
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id TEXT NOT NULL REFERENCES citizens(id),
  layer TEXT NOT NULL CHECK (layer IN ('short_term','episodic','relationship','belief','long_term')),
  content TEXT NOT NULL, game_time_ms INTEGER NOT NULL,
  importance INTEGER NOT NULL, source_event_id INTEGER REFERENCES events(id),
  other_id TEXT REFERENCES citizens(id), visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX memories_citizen ON memories(citizen_id, game_time_ms);
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id TEXT NOT NULL REFERENCES citizens(id),
  kind TEXT NOT NULL CHECK (kind IN ('observation','told','belief','rumor')),
  claim TEXT NOT NULL, confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  source_citizen_id TEXT REFERENCES citizens(id), source_event_id INTEGER REFERENCES events(id),
  game_time_ms INTEGER NOT NULL
);
CREATE TABLE secrets (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES citizens(id),
  claim TEXT NOT NULL, truth_status TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE secret_knowledge (
  secret_id TEXT NOT NULL REFERENCES secrets(id), citizen_id TEXT NOT NULL REFERENCES citizens(id),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  PRIMARY KEY (secret_id, citizen_id)
);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game_time_ms INTEGER NOT NULL,
  speaker_id TEXT NOT NULL REFERENCES citizens(id), recipient_id TEXT NOT NULL REFERENCES citizens(id),
  text TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public',
  source_event_id INTEGER REFERENCES events(id)
);
CREATE INDEX conversations_participants ON conversations(speaker_id, recipient_id, game_time_ms);
CREATE TABLE players (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('player','admin')),
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0,1)),
  avatar INTEGER NOT NULL DEFAULT 0 CHECK (avatar BETWEEN 0 AND 9),
  influence INTEGER NOT NULL DEFAULT 0 CHECK (influence >= 0),
  last_seen_game_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE observer_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id),
  text TEXT NOT NULL, created_at TEXT NOT NULL, game_time_ms INTEGER NOT NULL
);
CREATE TABLE money_transactions (
  id TEXT PRIMARY KEY, from_id TEXT REFERENCES citizens(id), to_id TEXT REFERENCES citizens(id),
  amount INTEGER NOT NULL CHECK (amount > 0), type TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id), game_time_ms INTEGER NOT NULL
);
CREATE TABLE day_archives (
  day INTEGER PRIMARY KEY, closed_game_ms INTEGER NOT NULL,
  newspaper TEXT NOT NULL CHECK (json_valid(newspaper)), major_event_ids TEXT NOT NULL CHECK (json_valid(major_event_ids))
);
CREATE TABLE investigations (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), day INTEGER NOT NULL,
  answers TEXT NOT NULL CHECK (json_valid(answers)), status TEXT NOT NULL,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  UNIQUE (player_id, day)
);
CREATE TABLE influence_ledger (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id),
  amount INTEGER NOT NULL, reason TEXT NOT NULL, game_time_ms INTEGER NOT NULL
);
CREATE TABLE interventions (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), day INTEGER NOT NULL,
  citizen_id TEXT NOT NULL REFERENCES citizens(id), strength TEXT NOT NULL,
  suggestion TEXT NOT NULL, cost INTEGER NOT NULL CHECK (cost >= 0), outcome TEXT NOT NULL,
  UNIQUE (player_id, day)
);
CREATE TABLE rumors (
  id TEXT PRIMARY KEY, proposer_id TEXT NOT NULL REFERENCES players(id),
  text TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL, proposed_day INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE rumor_approvals (
  rumor_id TEXT NOT NULL REFERENCES rumors(id), player_id TEXT NOT NULL REFERENCES players(id),
  revision INTEGER NOT NULL, PRIMARY KEY (rumor_id, player_id)
);
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL,
  model TEXT NOT NULL, base_url TEXT, enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config))
);
CREATE TABLE ai_keys (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE processed_commands (id TEXT PRIMARY KEY, result TEXT NOT NULL, world_version INTEGER NOT NULL);
` }, { version: 2, sql: `
CREATE TABLE simulation_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1), owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE closed_days (
  day INTEGER PRIMARY KEY, closed_game_ms INTEGER NOT NULL, event_id INTEGER NOT NULL REFERENCES events(id)
);
` }, { version: 3, sql: `
CREATE TABLE citizen_routines (
  citizen_id TEXT PRIMARY KEY REFERENCES citizens(id), goal_action TEXT NOT NULL DEFAULT 'idle',
  target_building_id TEXT REFERENCES buildings(id), path TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(path)),
  next_decision_game_ms INTEGER NOT NULL DEFAULT 0, movement_remainder REAL NOT NULL DEFAULT 0,
  next_speech_game_ms INTEGER NOT NULL DEFAULT 0, direction TEXT NOT NULL DEFAULT 'down'
);
CREATE TABLE schedules (
  citizen_id TEXT PRIMARY KEY REFERENCES citizens(id),
  shift_start INTEGER NOT NULL CHECK (shift_start BETWEEN 0 AND 1439),
  shift_end INTEGER NOT NULL CHECK (shift_end BETWEEN 1 AND 1440)
);
` }, { version: 4, sql: `
CREATE TABLE businesses (
  id TEXT PRIMARY KEY REFERENCES buildings(id), owner_id TEXT REFERENCES citizens(id),
  balance INTEGER NOT NULL CHECK(balance>=0), stock INTEGER NOT NULL CHECK(stock>=0),
  wage INTEGER NOT NULL CHECK(wage>0), capacity INTEGER NOT NULL CHECK(capacity>0), job_title TEXT NOT NULL
);
CREATE TABLE system_wallets (id TEXT PRIMARY KEY, balance INTEGER NOT NULL CHECK(balance>=0));
CREATE TABLE bank_accounts (citizen_id TEXT PRIMARY KEY REFERENCES citizens(id), balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE employment (
  citizen_id TEXT PRIMARY KEY REFERENCES citizens(id), business_id TEXT REFERENCES businesses(id),
  active INTEGER NOT NULL DEFAULT 1, work_day INTEGER NOT NULL, worked_ms INTEGER NOT NULL DEFAULT 0,
  wage_settled INTEGER NOT NULL DEFAULT 0, missed_days INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE employment_changes (id TEXT PRIMARY KEY, citizen_id TEXT NOT NULL REFERENCES citizens(id), business_id TEXT REFERENCES businesses(id), event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE debts (
  id TEXT PRIMARY KEY, borrower_account TEXT NOT NULL, lender_account TEXT NOT NULL,
  outstanding INTEGER NOT NULL CHECK(outstanding>=0), due_day INTEGER NOT NULL,
  kind TEXT NOT NULL, default_reported INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE economic_state (
  citizen_id TEXT PRIMARY KEY REFERENCES citizens(id), pantry INTEGER NOT NULL DEFAULT 2 CHECK(pantry>=0),
  meal_until INTEGER NOT NULL DEFAULT 0, next_food_attempt INTEGER NOT NULL DEFAULT 0, next_bank_visit INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE economy_days (day INTEGER PRIMARY KEY);
ALTER TABLE money_transactions ADD COLUMN from_account TEXT NOT NULL DEFAULT '';
ALTER TABLE money_transactions ADD COLUMN to_account TEXT NOT NULL DEFAULT '';
CREATE INDEX debts_borrower ON debts(borrower_account,outstanding);
` }];

export function migrate(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, new Date().toISOString());
    })();
  }
}
