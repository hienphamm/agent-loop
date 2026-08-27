import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded via createRequire instead of a static import: Node's `node:sqlite`
// is a newer built-in that some bundlers/test runners (Vite/Vitest) don't
// yet recognize as external, and a static import can fail to resolve there.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
export type DatabaseSync = DatabaseSyncType;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  current_conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  description TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  scope TEXT,
  risk TEXT NOT NULL DEFAULT 'low',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);

CREATE TABLE IF NOT EXISTS retries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  error TEXT,
  backoff_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retries_task ON retries(run_id, task_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  summary_json TEXT,
  token_count INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_run ON conversations(run_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  description TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'low',
  -- 'attempted': execution started but outcome is unknown (crash mid-flight).
  -- 'completed': execution finished and result_json is authoritative.
  status TEXT NOT NULL DEFAULT 'attempted',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_locks (
  run_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL, -- decision | fact | rule | artifact
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_run ON memory(run_id);
`;

export function openDatabase(stateDir: string): DatabaseSync {
  mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function openInMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}
