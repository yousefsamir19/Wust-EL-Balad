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
` }, { version: 5, sql: `
ALTER TABLE relationships ADD COLUMN secrets_known TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(secrets_known));
ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'observation';
ALTER TABLE memories ADD COLUMN confidence INTEGER NOT NULL DEFAULT 100 CHECK(confidence BETWEEN 0 AND 100);
ALTER TABLE secret_knowledge ADD COLUMN source_event_id INTEGER REFERENCES events(id);
ALTER TABLE secret_knowledge ADD COLUMN source_citizen_id TEXT REFERENCES citizens(id);
CREATE TABLE observed_events (
  citizen_id TEXT NOT NULL REFERENCES citizens(id),event_id INTEGER NOT NULL REFERENCES events(id),
  mode TEXT NOT NULL,PRIMARY KEY(citizen_id,event_id)
);
CREATE TABLE memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id),PRIMARY KEY(memory_id,event_id)
);
CREATE TABLE social_cursor(id INTEGER PRIMARY KEY CHECK(id=1),last_event_id INTEGER NOT NULL);
CREATE TABLE social_state (
  citizen_id TEXT PRIMARY KEY REFERENCES citizens(id),last_compaction_day INTEGER NOT NULL,last_decay_game_ms INTEGER NOT NULL
);
` }, { version: 6, sql: `
ALTER TABLE ai_keys ADD COLUMN label TEXT NOT NULL DEFAULT 'Key';
ALTER TABLE ai_keys ADD COLUMN last_error TEXT;
CREATE TABLE ai_provider_status (provider_id TEXT PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(json_valid(status)));
CREATE TABLE ai_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id TEXT REFERENCES players(id),action TEXT NOT NULL,provider_id TEXT,details TEXT NOT NULL CHECK(json_valid(details)),created_at TEXT NOT NULL);
` }, { version: 7, sql: `
ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
ALTER TABLE conversations ADD COLUMN stance TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE conversations ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs));
CREATE TABLE citizen_brains (citizen_id TEXT PRIMARY KEY REFERENCES citizens(id),next_think_game_ms INTEGER NOT NULL DEFAULT 0,last_event_id INTEGER NOT NULL DEFAULT 0,pending_id TEXT,last_trigger TEXT NOT NULL DEFAULT 'routine');
CREATE TABLE citizen_decisions (id TEXT PRIMARY KEY,citizen_id TEXT NOT NULL REFERENCES citizens(id),requested_version INTEGER NOT NULL,completed_game_ms INTEGER NOT NULL,origin TEXT NOT NULL,action TEXT NOT NULL CHECK(json_valid(action)),accepted INTEGER NOT NULL,reason TEXT);
` }, {version:8,sql:`
CREATE TABLE interrogations (id TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id),citizen_id TEXT NOT NULL REFERENCES citizens(id),question TEXT NOT NULL,answer TEXT,basis TEXT NOT NULL DEFAULT 'unknown',status TEXT NOT NULL DEFAULT 'pending',game_time_ms INTEGER NOT NULL,created_at TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'local',source_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs)));
CREATE INDEX interrogations_player_citizen ON interrogations(player_id,citizen_id,created_at);
` }, {version:9,sql:`
CREATE TABLE chronicle_sources(day INTEGER PRIMARY KEY REFERENCES closed_days(day),closed_game_ms INTEGER NOT NULL,snapshot_hash TEXT NOT NULL,events TEXT NOT NULL CHECK(json_valid(events)));
` }, {version:10,sql:`
CREATE TABLE investigation_truth(day INTEGER PRIMARY KEY REFERENCES closed_days(day),closed_game_ms INTEGER NOT NULL,facts TEXT NOT NULL CHECK(json_valid(facts)),snapshot_hash TEXT NOT NULL);
ALTER TABLE investigations ADD COLUMN created_at TEXT;
ALTER TABLE investigations ADD COLUMN completed_game_ms INTEGER;
` }, {version:11,sql:`
ALTER TABLE interventions ADD COLUMN event_id INTEGER REFERENCES events(id);
CREATE TABLE intervention_hints(id TEXT PRIMARY KEY REFERENCES interventions(id),citizen_id TEXT NOT NULL REFERENCES citizens(id),goal TEXT NOT NULL,bonus INTEGER NOT NULL CHECK(bonus BETWEEN 0 AND 20),expires_game_ms INTEGER NOT NULL,event_id INTEGER NOT NULL REFERENCES events(id));
ALTER TABLE citizen_routines ADD COLUMN decision_cause_id INTEGER REFERENCES events(id);
` }, {version:12,sql:`
ALTER TABLE rumors ADD COLUMN published_game_ms INTEGER;
ALTER TABLE rumors ADD COLUMN published_event_id INTEGER REFERENCES events(id);
ALTER TABLE rumors ADD COLUMN voter_snapshot TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(voter_snapshot));
ALTER TABLE rumors ADD COLUMN last_spread_game_ms INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX rumors_one_pending ON rumors(status) WHERE status='pending';
CREATE TABLE rumor_heard(rumor_id TEXT NOT NULL REFERENCES rumors(id),citizen_id TEXT NOT NULL REFERENCES citizens(id),confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),source_event_id INTEGER NOT NULL REFERENCES events(id),last_shared_game_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(rumor_id,citizen_id));
` }, {version:13,sql:`
CREATE TABLE player_visits(id INTEGER PRIMARY KEY AUTOINCREMENT,player_id TEXT NOT NULL REFERENCES players(id),seen_game_ms INTEGER NOT NULL,previous_seen_game_ms INTEGER);
CREATE TABLE player_returns(player_id TEXT PRIMARY KEY REFERENCES players(id),from_game_ms INTEGER NOT NULL);
CREATE TABLE player_reviewed_days(player_id TEXT NOT NULL REFERENCES players(id),day INTEGER NOT NULL,PRIMARY KEY(player_id,day));
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
