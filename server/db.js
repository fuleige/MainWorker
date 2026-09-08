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

      CREATE TABLE IF NOT EXISTS article_revisions (
        id INTEGER PRIMARY KEY,
        article_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        article_path TEXT NOT NULL,
        turn_id TEXT NOT NULL UNIQUE,
        before_hash TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        before_source TEXT NOT NULL,
        after_source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reverted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_article_revisions_article
        ON article_revisions(article_key, created_at DESC, id DESC);

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
    this.#initializePlannerSchema();
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

  #plannerSchemaSql() {
    return `
      CREATE TABLE IF NOT EXISTS planner_projects (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS planner_recurrences (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES planner_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        frequency TEXT NOT NULL CHECK(frequency IN ('daily','workdays','weekly')),
        weekdays_json TEXT NOT NULL DEFAULT '[]',
        start_date TEXT NOT NULL,
        end_date TEXT,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','ended')),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS planner_tasks (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES planner_projects(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES planner_tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done','canceled','skipped')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        planned_date TEXT,
        deadline_date TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        recurrence_id INTEGER REFERENCES planner_recurrences(id) ON DELETE CASCADE,
        occurrence_date TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(recurrence_id, occurrence_date),
        CHECK(recurrence_id IS NULL OR (parent_id IS NULL AND occurrence_date IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS planner_recurrence_subtasks (
        id INTEGER PRIMARY KEY,
        recurrence_id INTEGER NOT NULL REFERENCES planner_recurrences(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_planner_projects_status_position
        ON planner_projects(status, position, id);
      CREATE INDEX IF NOT EXISTS idx_planner_tasks_project_parent_position
        ON planner_tasks(project_id, parent_id, position, id);
      CREATE INDEX IF NOT EXISTS idx_planner_tasks_execution
        ON planner_tasks(status, planned_date, deadline_date, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_tasks_open_recurrence
        ON planner_tasks(recurrence_id)
        WHERE recurrence_id IS NOT NULL AND parent_id IS NULL AND status IN ('todo','doing');
      CREATE INDEX IF NOT EXISTS idx_planner_recurrences_project_state
        ON planner_recurrences(project_id, state, position, id);
      CREATE INDEX IF NOT EXISTS idx_planner_recurrence_subtasks_rule_position
        ON planner_recurrence_subtasks(recurrence_id, position, id);
    `;
  }

  #initializePlannerSchema() {
    const taskTable = this.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'planner_tasks'").get();
    if (!taskTable) {
      this.database.exec(this.#plannerSchemaSql());
      return;
    }
    const columns = this.database.prepare('PRAGMA table_info(planner_tasks)').all();
    if (columns.some((column) => column.name === 'project_id')) {
      this.database.exec(this.#plannerSchemaSql());
      return;
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('ALTER TABLE planner_tasks RENAME TO planner_tasks_legacy');
      this.database.exec(this.#plannerSchemaSql());
      this.database.exec(`
        INSERT INTO planner_projects(id, title, notes, status, position, created_at, updated_at)
        SELECT id, title, notes, 'active', id, created_at, updated_at
        FROM planner_tasks_legacy
        WHERE parent_id IS NULL
        ORDER BY id;

        INSERT INTO planner_tasks(
          id, project_id, parent_id, title, notes, status, priority,
          planned_date, deadline_date, position, created_at, updated_at
        )
        SELECT child.id, child.parent_id, NULL, child.title, child.notes,
          CASE child.status WHEN 'done' THEN 'done' WHEN 'doing' THEN 'doing' ELSE 'todo' END,
          child.priority, child.due_date, NULL, child.id, child.created_at, child.updated_at
        FROM planner_tasks_legacy child
        JOIN planner_tasks_legacy project ON project.id = child.parent_id AND project.parent_id IS NULL
        ORDER BY child.id;
      `);
      const legacyCount = Number(this.database.prepare('SELECT COUNT(*) AS count FROM planner_tasks_legacy').get().count);
      const migratedCount = Number(this.database.prepare('SELECT (SELECT COUNT(*) FROM planner_projects) + (SELECT COUNT(*) FROM planner_tasks) AS count').get().count);
      if (legacyCount !== migratedCount) throw new Error('规划数据层级超出迁移规则，已停止迁移');
      this.database.exec('DROP TABLE planner_tasks_legacy');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
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

  createArticleRevision(revision) {
    this.database.prepare(`
      INSERT OR IGNORE INTO article_revisions(
        article_key, source_id, article_path, turn_id, before_hash, after_hash, before_source, after_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.articleKey, revision.sourceId, revision.articlePath, revision.turnId,
      revision.beforeHash, revision.afterHash, revision.beforeSource, revision.afterSource,
    );
    this.database.prepare(`
      DELETE FROM article_revisions
      WHERE article_key = ? AND id NOT IN (
        SELECT id FROM article_revisions WHERE article_key = ? ORDER BY id DESC LIMIT 20
      )
    `).run(revision.articleKey, revision.articleKey);
    return this.getArticleRevisionByTurn(revision.turnId);
  }

  getArticleRevisionByTurn(turnId) {
    return this.database.prepare('SELECT * FROM article_revisions WHERE turn_id = ?').get(turnId) || null;
  }

  getArticleRevision(id) {
    return this.database.prepare('SELECT * FROM article_revisions WHERE id = ?').get(id) || null;
  }

  markArticleRevisionReverted(id, revertedAt = new Date().toISOString()) {
    this.database.prepare('UPDATE article_revisions SET reverted_at = ? WHERE id = ?').run(revertedAt, id);
    return this.getArticleRevision(id);
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT * FROM planner_projects
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        position, id
    `).all();
  }

  getProject(id) {
    return this.database.prepare('SELECT * FROM planner_projects WHERE id = ?').get(id) || null;
  }

  createProject(project) {
    const position = project.position ?? Number(this.database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM planner_projects').get().position);
    const result = this.database.prepare(`
      INSERT INTO planner_projects(title, notes, status, position) VALUES (?, ?, ?, ?)
    `).run(project.title, project.notes || '', project.status || 'active', position);
    return this.getProject(Number(result.lastInsertRowid));
  }

  updateProject(id, project) {
    const current = this.getProject(id);
    if (!current) return null;
    const next = {
      title: project.title ?? current.title,
      notes: project.notes ?? current.notes,
      status: project.status ?? current.status,
      position: project.position ?? current.position,
    };
    this.database.prepare(`
      UPDATE planner_projects SET title = ?, notes = ?, status = ?, position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(next.title, next.notes, next.status, next.position, id);
    return this.getProject(id);
  }

  deleteProject(id) {
    return this.database.prepare('DELETE FROM planner_projects WHERE id = ?').run(id).changes > 0;
  }

  listTasks() {
    return this.database.prepare(`
      SELECT * FROM planner_tasks
      ORDER BY project_id, parent_id IS NOT NULL,
        CASE WHEN parent_id IS NULL THEN position ELSE parent_id END,
        position, id
    `).all();
  }

  listProjectTasks(projectId) {
    return this.database.prepare(`
      SELECT * FROM planner_tasks WHERE project_id = ?
      ORDER BY parent_id IS NOT NULL,
        CASE WHEN parent_id IS NULL THEN position ELSE parent_id END,
        position, id
    `).all(projectId);
  }

  getTask(id) {
    return this.database.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id) || null;
  }

  createTask(task) {
    const position = task.position ?? Number(this.database.prepare(`
      SELECT COALESCE(MAX(position), -1) + 1 AS position
      FROM planner_tasks WHERE project_id = ? AND parent_id IS ?
    `).get(task.projectId, task.parentId || null).position);
    const result = this.database.prepare(`
      INSERT INTO planner_tasks(
        project_id, parent_id, title, notes, status, priority, planned_date,
        deadline_date, position, recurrence_id, occurrence_date, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.projectId, task.parentId || null, task.title, task.notes || '', task.status || 'todo',
      task.priority || 'medium', task.plannedDate || null, task.deadlineDate || null, position,
      task.recurrenceId || null, task.occurrenceDate || null, task.completedAt || null,
    );
    return this.getTask(Number(result.lastInsertRowid));
  }

  updateTask(id, task) {
    const current = this.getTask(id);
    if (!current) return null;
    const next = {
      projectId: task.projectId ?? current.project_id,
      parentId: task.parentId === undefined ? current.parent_id : task.parentId || null,
      title: task.title ?? current.title,
      notes: task.notes ?? current.notes,
      status: task.status ?? current.status,
      priority: task.priority ?? current.priority,
      plannedDate: task.plannedDate === undefined ? current.planned_date : task.plannedDate || null,
      deadlineDate: task.deadlineDate === undefined ? current.deadline_date : task.deadlineDate || null,
      position: task.position ?? current.position,
      completedAt: task.completedAt === undefined ? current.completed_at : task.completedAt || null,
    };
    this.database.prepare(`
      UPDATE planner_tasks SET project_id = ?, parent_id = ?, title = ?, notes = ?, status = ?,
        priority = ?, planned_date = ?, deadline_date = ?, position = ?, completed_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      next.projectId, next.parentId, next.title, next.notes, next.status, next.priority,
      next.plannedDate, next.deadlineDate, next.position, next.completedAt, id,
    );
    return this.getTask(id);
  }

  deleteTask(id) {
    return this.database.prepare('DELETE FROM planner_tasks WHERE id = ?').run(id).changes > 0;
  }

  listTaskChildren(id) {
    return this.database.prepare('SELECT * FROM planner_tasks WHERE parent_id = ? ORDER BY position, id').all(id);
  }

  listRecurrences() {
    return this.database.prepare(`
      SELECT * FROM planner_recurrences
      ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, project_id, position, id
    `).all();
  }

  getRecurrence(id) {
    return this.database.prepare('SELECT * FROM planner_recurrences WHERE id = ?').get(id) || null;
  }

  getOpenRecurrenceTask(recurrenceId) {
    return this.database.prepare(`
      SELECT * FROM planner_tasks
      WHERE recurrence_id = ? AND parent_id IS NULL AND status IN ('todo','doing')
      ORDER BY id DESC LIMIT 1
    `).get(recurrenceId) || null;
  }

  getLatestRecurrenceTask(recurrenceId) {
    return this.database.prepare(`
      SELECT * FROM planner_tasks
      WHERE recurrence_id = ? AND parent_id IS NULL
      ORDER BY occurrence_date DESC, id DESC LIMIT 1
    `).get(recurrenceId) || null;
  }

  listRecurrenceSubtasks(recurrenceId) {
    return this.database.prepare(`
      SELECT * FROM planner_recurrence_subtasks WHERE recurrence_id = ? ORDER BY position, id
    `).all(recurrenceId);
  }

  createRecurrence(recurrence, firstOccurrenceDate) {
    return this.transaction(() => {
      const position = recurrence.position ?? Number(this.database.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS position FROM planner_recurrences WHERE project_id = ?
      `).get(recurrence.projectId).position);
      const result = this.database.prepare(`
        INSERT INTO planner_recurrences(
          project_id, title, notes, priority, frequency, weekdays_json,
          start_date, end_date, state, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        recurrence.projectId, recurrence.title, recurrence.notes || '', recurrence.priority || 'medium',
        recurrence.frequency, JSON.stringify(recurrence.weekdays || []), recurrence.startDate,
        recurrence.endDate || null, position,
      );
      const recurrenceId = Number(result.lastInsertRowid);
      for (const [index, subtask] of (recurrence.subtasks || []).entries()) {
        this.database.prepare(`
          INSERT INTO planner_recurrence_subtasks(recurrence_id, title, notes, priority, position)
          VALUES (?, ?, ?, ?, ?)
        `).run(recurrenceId, subtask.title, subtask.notes || '', subtask.priority || 'medium', index);
      }
      if (firstOccurrenceDate && (!recurrence.endDate || firstOccurrenceDate <= recurrence.endDate)) {
        this.insertRecurrenceOccurrence(recurrenceId, firstOccurrenceDate);
      }
      return this.getRecurrence(recurrenceId);
    });
  }

  updateRecurrence(id, recurrence) {
    const current = this.getRecurrence(id);
    if (!current) return null;
    const next = {
      projectId: recurrence.projectId ?? current.project_id,
      title: recurrence.title ?? current.title,
      notes: recurrence.notes ?? current.notes,
      priority: recurrence.priority ?? current.priority,
      frequency: recurrence.frequency ?? current.frequency,
      weekdays: recurrence.weekdays === undefined ? current.weekdays_json : JSON.stringify(recurrence.weekdays),
      startDate: recurrence.startDate ?? current.start_date,
      endDate: recurrence.endDate === undefined ? current.end_date : recurrence.endDate || null,
      state: recurrence.state ?? current.state,
      position: recurrence.position ?? current.position,
    };
    this.database.prepare(`
      UPDATE planner_recurrences SET project_id = ?, title = ?, notes = ?, priority = ?,
        frequency = ?, weekdays_json = ?, start_date = ?, end_date = ?, state = ?, position = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(
      next.projectId, next.title, next.notes, next.priority, next.frequency, next.weekdays,
      next.startDate, next.endDate, next.state, next.position, id,
    );
    return this.getRecurrence(id);
  }

  replaceRecurrenceSubtasks(recurrenceId, subtasks) {
    this.database.prepare('DELETE FROM planner_recurrence_subtasks WHERE recurrence_id = ?').run(recurrenceId);
    for (const [index, subtask] of subtasks.entries()) {
      this.database.prepare(`
        INSERT INTO planner_recurrence_subtasks(recurrence_id, title, notes, priority, position)
        VALUES (?, ?, ?, ?, ?)
      `).run(recurrenceId, subtask.title, subtask.notes || '', subtask.priority || 'medium', index);
    }
    return this.listRecurrenceSubtasks(recurrenceId);
  }

  createRecurrenceOccurrence(recurrenceId, occurrenceDate) {
    return this.transaction(() => this.insertRecurrenceOccurrence(recurrenceId, occurrenceDate));
  }

  insertRecurrenceOccurrence(recurrenceId, occurrenceDate) {
    const recurrence = this.getRecurrence(recurrenceId);
    if (!recurrence) throw new Error('循环规则不存在');
    const task = this.createTask({
      projectId: Number(recurrence.project_id), title: recurrence.title, notes: recurrence.notes,
      status: 'todo', priority: recurrence.priority, plannedDate: occurrenceDate,
      recurrenceId, occurrenceDate, position: recurrence.position,
    });
    for (const template of this.listRecurrenceSubtasks(recurrenceId)) {
      this.createTask({
        projectId: Number(recurrence.project_id), parentId: Number(task.id), title: template.title,
        notes: template.notes, status: 'todo', priority: template.priority,
        plannedDate: occurrenceDate, position: template.position,
      });
    }
    return task;
  }

  deleteRecurrence(id) {
    return this.database.prepare('DELETE FROM planner_recurrences WHERE id = ?').run(id).changes > 0;
  }
}
