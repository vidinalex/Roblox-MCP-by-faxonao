import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openAutomationDatabase(filePath) {
  return new DatabaseSync(filePath);
}

export async function bootstrapAutomationDatabase(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  const db = openAutomationDatabase(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_ref TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      project_profile_id TEXT,
      place_id TEXT,
      state TEXT NOT NULL,
      task_type TEXT NOT NULL,
      requires_studio INTEGER NOT NULL DEFAULT 0,
      requires_manual_verification INTEGER NOT NULL DEFAULT 0,
      requires_clarification INTEGER NOT NULL DEFAULT 0,
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      executor_prompt TEXT NOT NULL DEFAULT '',
      blocked_reason TEXT NOT NULL DEFAULT '',
      triage_summary TEXT NOT NULL DEFAULT '',
      execution_summary TEXT NOT NULL DEFAULT '',
      last_operator_message_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      body TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_questions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT NOT NULL DEFAULT '',
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      path TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_links (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_url TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, link_type, external_id)
    );

    CREATE TABLE IF NOT EXISTS project_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      port TEXT NOT NULL,
      expected_place_id TEXT NOT NULL DEFAULT '',
      wsl_workspace_path TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      source_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS runtime_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      last_task_id TEXT NOT NULL DEFAULT '',
      last_user_goal TEXT NOT NULL DEFAULT '',
      last_agent_action TEXT NOT NULL DEFAULT '',
      pending_execution_json TEXT NOT NULL DEFAULT '{}',
      last_suggestions_json TEXT NOT NULL DEFAULT '[]',
      source_context_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel, external_id)
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_events (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      user_text TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  ensureTaskColumns(db);
  return db;
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function ensureColumn(db, tableName, columnName, sqlDefinition) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlDefinition}`);
  }
}

function ensureTaskColumns(db) {
  ensureColumn(db, "tasks", "conversation_key", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "intent_type", "TEXT NOT NULL DEFAULT 'general'");
  ensureColumn(db, "tasks", "visibility", "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, "tasks", "source_context_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "tasks", "last_agent_action", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "last_user_goal", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "tasks", "execution_pending_confirmation", "INTEGER NOT NULL DEFAULT 0");
}
