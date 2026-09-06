import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function sessionTitle(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '新会话';
  return normalized.length > 32 ? `${normalized.slice(0, 32)}…` : normalized;
}

export class WorkbenchDatabase {
  constructor(dataDirectory) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDirectory, 0o700);
    const databasePath = path.join(dataDirectory, 'mainworker.sqlite');
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        context_key TEXT NOT NULL,
        thread_id TEXT UNIQUE,
        mode TEXT NOT NULL DEFAULT 'work' CHECK(mode IN ('work','quick')),
        model TEXT,
        reasoning_effort TEXT,
        title TEXT NOT NULL DEFAULT '新会话',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_context_activity
        ON chat_sessions(scope, context_key, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inProgress',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turns_session_created
        ON chat_turns(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS chat_events (
        id INTEGER PRIMARY KEY,
        turn_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(turn_id, seq),
        FOREIGN KEY (turn_id) REFERENCES chat_turns(turn_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_events_turn_seq ON chat_events(turn_id, seq);

      CREATE TABLE IF NOT EXISTS quick_phrases (
        id INTEGER PRIMARY KEY,
        phrase_text TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS article_activity (
        article_path TEXT PRIMARY KEY,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planner_tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('inbox','todo','doing','done')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        due_date TEXT,
        project TEXT NOT NULL DEFAULT '',
        parent_id INTEGER REFERENCES planner_tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_planner_tasks_status_due
        ON planner_tasks(status, due_date, id);
    `);
    const sessionColumns = this.database.prepare('PRAGMA table_info(chat_sessions)').all();
    if (!sessionColumns.some((column) => column.name === 'mode')) {
      this.database.exec("ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'work' CHECK(mode IN ('work','quick'))");
    }
    if (!sessionColumns.some((column) => column.name === 'model')) {
      this.database.exec('ALTER TABLE chat_sessions ADD COLUMN model TEXT');
    }
    if (!sessionColumns.some((column) => column.name === 'reasoning_effort')) {
      this.database.exec('ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT');
    }
    const plannerColumns = this.database.prepare('PRAGMA table_info(planner_tasks)').all();
    if (!plannerColumns.some((column) => column.name === 'parent_id')) {
      this.database.exec('ALTER TABLE planner_tasks ADD COLUMN parent_id INTEGER REFERENCES planner_tasks(id) ON DELETE CASCADE');
    }
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_planner_tasks_parent_id ON planner_tasks(parent_id, id)');
    this.database.exec(`
      UPDATE chat_turns SET status = 'interrupted',
        error = COALESCE(error, '工作台服务重启，本轮实时任务已中断'),
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'inProgress'
    `);
    this.database.exec('PRAGMA optimize');
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${databasePath}${suffix}`;
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
  }

  createSession(scope, contextKey, mode = 'work', model = null, reasoningEffort = null) {
    const result = this.database.prepare('INSERT INTO chat_sessions(scope, context_key, mode, model, reasoning_effort) VALUES (?, ?, ?, ?, ?)').run(scope, contextKey, mode, model, reasoningEffort);
    return this.getSession(scope, contextKey, Number(result.lastInsertRowid));
  }

  getSession(scope, contextKey, id) {
    return this.database.prepare(`
      SELECT s.*, COUNT(t.id) AS turn_count, COALESCE(MAX(t.updated_at), s.updated_at) AS activity_at
      FROM chat_sessions s LEFT JOIN chat_turns t ON t.session_id = s.id
      WHERE s.id = ? AND s.scope = ? AND s.context_key = ? GROUP BY s.id
    `).get(id, scope, contextKey) || null;
  }

  listSessions(scope, contextKey) {
    return this.database.prepare(`
      SELECT s.*, COUNT(t.id) AS turn_count, COALESCE(MAX(t.updated_at), s.updated_at) AS activity_at
      FROM chat_sessions s LEFT JOIN chat_turns t ON t.session_id = s.id
      WHERE s.scope = ? AND s.context_key = ? GROUP BY s.id
      ORDER BY activity_at DESC, s.id DESC
    `).all(scope, contextKey);
  }

  attachThread(id, threadId) {
    this.database.prepare('UPDATE chat_sessions SET thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId, id);
  }

  touchSession(id) {
    this.database.prepare('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  updateSessionSettings(id, model, reasoningEffort) {
    this.database.prepare('UPDATE chat_sessions SET model = ?, reasoning_effort = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(model, reasoningEffort, id);
  }

  nameNewSession(id, text) {
    this.database.prepare("UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND title = '新会话'").run(sessionTitle(text), id);
  }

  deleteSession(scope, contextKey, id) {
    return this.database.prepare('DELETE FROM chat_sessions WHERE id = ? AND scope = ? AND context_key = ?').run(id, scope, contextKey).changes > 0;
  }

  createTurn({ sessionId, threadId, turnId, userText }) {
    this.database.prepare(`INSERT INTO chat_turns(session_id, thread_id, turn_id, user_text) VALUES (?, ?, ?, ?)`).run(sessionId, threadId, turnId, userText);
    this.nameNewSession(sessionId, userText);
  }

  updateTurn({ turnId, assistantText, status, error = null }) {
    this.database.prepare(`UPDATE chat_turns SET assistant_text = ?, status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE turn_id = ?`).run(assistantText, status, error, turnId);
  }

  listTurns(sessionId) {
    return this.database.prepare('SELECT * FROM chat_turns WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  }

  getTurn(sessionId, turnId) {
    return this.database.prepare('SELECT * FROM chat_turns WHERE turn_id = ? AND session_id = ?').get(turnId, sessionId) || null;
  }

  addEvent(turnId, seq, type, payload) {
    this.database.prepare('INSERT OR IGNORE INTO chat_events(turn_id, seq, event_type, payload_json) VALUES (?, ?, ?, ?)').run(turnId, seq, type, JSON.stringify(payload));
  }

  listEvents(turnId, afterSeq = 0) {
    return this.database.prepare('SELECT * FROM chat_events WHERE turn_id = ? AND seq > ? ORDER BY seq ASC').all(turnId, afterSeq).map((event) => ({
      seq: event.seq,
      event: event.event_type,
      payload: JSON.parse(event.payload_json),
    }));
  }

  listQuickPhrases() {
    return this.database.prepare('SELECT id, phrase_text, created_at FROM quick_phrases ORDER BY id DESC').all();
  }

  createQuickPhrase(text) {
    const result = this.database.prepare('INSERT OR IGNORE INTO quick_phrases(phrase_text) VALUES (?)').run(text);
    if (!result.changes) return null;
    return this.database.prepare('SELECT id, phrase_text, created_at FROM quick_phrases WHERE id = ?').get(Number(result.lastInsertRowid));
  }

  deleteQuickPhrase(id) {
    return this.database.prepare('DELETE FROM quick_phrases WHERE id = ?').run(id).changes > 0;
  }

  readSetting(key) {
    const row = this.database.prepare('SELECT value_json FROM app_settings WHERE setting_key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return null;
    }
  }

  writeSetting(key, value) {
    this.database.prepare(`
      INSERT INTO app_settings(setting_key, value_json) VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
    `).run(key, JSON.stringify(value));
    return this.readSetting(key);
  }

  markArticleOpened(articlePath, openedAt = new Date().toISOString()) {
    this.database.prepare(`INSERT INTO article_activity(article_path, last_opened_at) VALUES (?, ?) ON CONFLICT(article_path) DO UPDATE SET last_opened_at = excluded.last_opened_at`).run(articlePath, openedAt);
    return openedAt;
  }

  listArticleActivity() {
    return new Map(this.database.prepare('SELECT article_path, last_opened_at FROM article_activity').all().map((entry) => [entry.article_path, entry.last_opened_at]));
  }

  listTasks() {
    return this.database.prepare(`SELECT * FROM planner_tasks ORDER BY status = 'done', due_date IS NULL, due_date, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC`).all();
  }

  createTask(task) {
    const result = this.database.prepare(`INSERT INTO planner_tasks(title, notes, status, priority, due_date, project, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      task.title, task.notes || '', task.status || 'todo', task.priority || 'medium', task.dueDate || null, task.project || '', task.parentId || null,
    );
    return this.getTask(Number(result.lastInsertRowid));
  }

  getTask(id) {
    return this.database.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id) || null;
  }

  updateTask(id, task) {
    const current = this.getTask(id);
    if (!current) return null;
    const next = {
      title: task.title ?? current.title,
      notes: task.notes ?? current.notes,
      status: task.status ?? current.status,
      priority: task.priority ?? current.priority,
      dueDate: task.dueDate === undefined ? current.due_date : task.dueDate || null,
      project: task.project ?? current.project,
    };
    this.database.prepare(`UPDATE planner_tasks SET title = ?, notes = ?, status = ?, priority = ?, due_date = ?, project = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      next.title, next.notes, next.status, next.priority, next.dueDate, next.project, id,
    );
    return this.getTask(id);
  }

  deleteTask(id) {
    return this.database.prepare('DELETE FROM planner_tasks WHERE id = ?').run(id).changes > 0;
  }
}
