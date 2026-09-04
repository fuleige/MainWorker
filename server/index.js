import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { CodexAppServerClient } from './codex-client.js';
import { ContentRepository, renderMarkdown } from './content.js';
import { WorkbenchDatabase } from './db.js';
import { RateLimitService } from './rate-limits.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(projectRoot, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const dataRoot = path.join(projectRoot, '.data');
const staticRoot = path.join(projectRoot, 'dist', 'client');
const articleRoot = path.resolve(process.env.ARTICLE_ROOT || '/Users/fulei/Codes/Basic');
const algorithmArticleRoot = path.resolve(process.env.ALGORITHM_ARTICLE_ROOT || path.join(projectRoot, '..', 'AlgorithmLearn'));
const articleSources = [{
  id: 'basic',
  name: path.basename(articleRoot),
  root: articleRoot,
  articleDirectories: ['articles'],
  includeRootMarkdown: true,
}, {
  id: 'algorithm-learn',
  name: path.basename(algorithmArticleRoot),
  root: algorithmArticleRoot,
  articleDirectories: ['leetcode-math'],
  includeReadme: true,
}];
const host = process.env.API_HOST || '127.0.0.1';
const port = Number(process.env.API_PORT || 4390);
const auth = createAuth(dataRoot);
const database = new WorkbenchDatabase(dataRoot);
const content = new ContentRepository(articleSources);
const articleSourceIds = new Set(content.listSources().map((source) => source.id));
const defaultArticleSourceId = articleSources[0].id;
const codex = new CodexAppServerClient();
const rateLimits = new RateLimitService({ readRemote: () => codex.readAccountRateLimits(projectRoot) });
const activeRunsBySession = new Map();
const activeRunsById = new Map();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 6;
const REPLAYABLE_EVENTS = new Set(['run', 'meta', 'activity', 'reasoning', 'plan', 'metrics', 'error']);

codex.on('event', (message) => {
  if (message.method === 'account/rateLimits/updated') rateLimits.applyUpdate(message.params?.rateLimits);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function verifySameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function loginKey(request) {
  return request.socket.remoteAddress || 'unknown';
}

function checkLoginLimit(request) {
  const key = loginKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 0, startedAt: now });
    return { allowed: true, key };
  }
  return { allowed: current.count < LOGIN_ATTEMPT_LIMIT, key, retryAfter: Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - current.startedAt)) / 1000)) };
}

function recordLoginFailure(key) {
  const current = loginAttempts.get(key) || { count: 0, startedAt: Date.now() };
  current.count += 1;
  loginAttempts.set(key, current);
}

function resolveChatContext(scopeValue, articlePathValue, sourceIdValue) {
  const scope = String(scopeValue || 'workspace');
  if (scope === 'workspace') return { scope, key: 'workspace', cwd: projectRoot, markdownBase: '_workbench.md', articlePath: null, sourceId: null };
  const source = content.resolveSource(sourceIdValue);
  if (scope === 'articles') {
    return {
      scope,
      key: source.id === defaultArticleSourceId ? 'articles' : `articles:${source.id}`,
      cwd: source.root,
      markdownBase: '_project_context.md',
      articlePath: null,
      sourceId: source.id,
      sourceName: source.name,
    };
  }
  if (scope === 'article') {
    const article = content.resolveArticle(source.id, String(articlePathValue || ''));
    return {
      scope,
      key: article.key,
      cwd: article.source.root,
      markdownBase: article.relative,
      articlePath: article.relative,
      sourceId: article.source.id,
      sourceName: article.source.name,
    };
  }
  throw new Error('对话范围无效');
}

function publicSession(session) {
  return {
    id: Number(session.id), scope: session.scope, contextKey: session.context_key,
    threadId: session.thread_id || null, title: session.title,
    createdAt: session.created_at, updatedAt: session.activity_at || session.updated_at,
    turnCount: Number(session.turn_count || 0), running: activeRunsBySession.has(Number(session.id)),
  };
}

function publicTask(task) {
  return {
    id: Number(task.id), title: task.title, notes: task.notes, status: task.status,
    priority: task.priority, dueDate: task.due_date, project: task.project,
    parentId: task.parent_id ? Number(task.parent_id) : null,
    createdAt: task.created_at, updatedAt: task.updated_at,
  };
}

function publicRateLimitWindow(window) {
  if (!window) return null;
  return {
    usedPercent: Number(window.usedPercent || 0),
    windowDurationMins: window.windowDurationMins == null ? null : Number(window.windowDurationMins),
    resetsAt: window.resetsAt == null ? null : Number(window.resetsAt),
  };
}

function publicRateLimit(limit, fallbackId) {
  return {
    id: String(limit.limitId || fallbackId || 'codex'),
    name: limit.limitName ? String(limit.limitName) : null,
    planType: limit.planType ? String(limit.planType) : null,
    primary: publicRateLimitWindow(limit.primary),
    secondary: publicRateLimitWindow(limit.secondary),
    credits: limit.credits ? {
      hasCredits: Boolean(limit.credits.hasCredits),
      unlimited: Boolean(limit.credits.unlimited),
      balance: limit.credits.balance == null ? null : String(limit.credits.balance),
    } : null,
    individualLimit: limit.individualLimit ? {
      limit: String(limit.individualLimit.limit),
      used: String(limit.individualLimit.used),
      remainingPercent: Number(limit.individualLimit.remainingPercent),
      resetsAt: Number(limit.individualLimit.resetsAt),
    } : null,
    spendControlReached: limit.spendControlReached == null ? null : Boolean(limit.spendControlReached),
    reachedType: limit.rateLimitReachedType ? String(limit.rateLimitReachedType) : null,
  };
}

function publicResetCredit(credit) {
  return {
    id: String(credit.id),
    title: credit.title == null ? null : String(credit.title),
    description: credit.description == null ? null : String(credit.description),
    expiresAt: credit.expiresAt == null ? null : Number(credit.expiresAt),
  };
}

function publicRateLimits(result) {
  const snapshot = result.snapshot || {};
  const byId = snapshot.rateLimitsByLimitId;
  const resetCreditSummary = snapshot.rateLimitResetCredits;
  const entries = byId && Object.keys(byId).length
    ? Object.entries(byId)
    : snapshot.rateLimits ? [[snapshot.rateLimits.limitId || 'codex', snapshot.rateLimits]] : [];
  return {
    limits: entries.filter(([, limit]) => limit).map(([id, limit]) => publicRateLimit(limit, id)),
    resetCreditsCount: resetCreditSummary?.availableCount == null
      ? null
      : Number(resetCreditSummary.availableCount),
    resetCredits: resetCreditSummary?.credits == null
      ? null
      : resetCreditSummary.credits.map(publicResetCredit),
    fetchedAt: result.fetchedAt,
    nextRefreshAt: result.nextRefreshAt,
    refreshAllowedAt: result.refreshAllowedAt,
    cached: result.cached,
    stale: result.stale,
    refreshError: result.refreshError,
    policy: result.policy,
  };
}

function sendSse(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openSse(response) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
}

function subscribeRun(run, response) {
  run.subscribers.add(response);
  response.once('close', () => run.subscribers.delete(response));
}

function publishRun(run, event, payload) {
  run.seq += 1;
  const data = { ...payload, elapsedMs: payload.elapsedMs ?? Date.now() - run.startedAt, seq: run.seq };
  if (REPLAYABLE_EVENTS.has(event)) {
    const entry = { seq: run.seq, event, payload: data, persisted: false };
    run.events.push(entry);
    if (run.events.length > 500) run.events.shift();
    if (run.turnId) {
      database.addEvent(run.turnId, entry.seq, entry.event, entry.payload);
      entry.persisted = true;
    }
  }
  for (const subscriber of run.subscribers) sendSse(subscriber, event, data);
  return data;
}

function persistPendingEvents(run) {
  if (!run.turnId) return;
  for (const entry of run.events) {
    if (entry.persisted) continue;
    database.addEvent(run.turnId, entry.seq, entry.event, entry.payload);
    entry.persisted = true;
  }
}

function finishRun(run) {
  if (activeRunsBySession.get(run.sessionId) === run) activeRunsBySession.delete(run.sessionId);
  activeRunsById.delete(run.id);
  for (const subscriber of run.subscribers) if (!subscriber.writableEnded) subscriber.end();
  run.subscribers.clear();
}

function publicRun(run) {
  return {
    runId: run.id, sessionId: run.sessionId, scope: run.context.scope,
    articlePath: run.context.articlePath, sourceId: run.context.sourceId, threadId: run.threadId, turnId: run.turnId,
    userText: run.userText, assistantText: run.assistantText, status: run.status,
    startedAt: run.startedAt, firstDeltaMs: run.firstDeltaAt ? run.firstDeltaAt - run.startedAt : null,
    elapsedMs: Date.now() - run.startedAt, seq: run.seq,
    events: run.events.map(({ seq, event, payload }) => ({ seq, event, payload })),
  };
}

async function ensureThread(session, context) {
  if (!session.thread_id) {
    const thread = await codex.createThread(context);
    database.attachThread(session.id, thread.id);
    return { threadId: thread.id, restored: false };
  }
  await codex.resumeThread(session.thread_id, context);
  database.touchSession(session.id);
  return { threadId: session.thread_id, restored: true };
}

function activityForItem(item, completed = false) {
  if (!item?.type || item.type === 'userMessage') return null;
  if (item.type === 'reasoning') return { phase: 'reasoning', label: completed ? '分析完成' : '正在分析请求' };
  if (item.type === 'agentMessage') return { phase: 'answer', label: completed ? '回答生成完成' : '正在生成回答' };
  if (item.type === 'plan') return { phase: 'plan', label: '正在更新执行计划' };
  if (item.type === 'commandExecution') return { phase: 'command', label: completed ? '终端命令已完成' : '正在执行终端命令', detail: completed ? '命令输出已处理' : 'Codex 正在本机执行操作' };
  if (item.type === 'fileChange') return { phase: 'file', label: completed ? '文件修改已处理' : '正在修改文件' };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { phase: 'tool', label: completed ? '工具调用完成' : '正在调用工具' };
  if (item.type === 'webSearch') return { phase: 'search', label: completed ? '资料搜索完成' : '正在搜索资料' };
  if (item.type === 'contextCompaction') return { phase: 'context', label: '正在整理长期上下文' };
  return { phase: 'work', label: completed ? '操作完成' : '正在处理' };
}

async function executeRun(run, session) {
  let completed = false;
  let finishing = false;
  const earlyEvents = [];
  const heartbeat = setInterval(() => publishRun(run, 'heartbeat', {}), 10_000);
  const cleanup = () => { clearInterval(heartbeat); codex.off('event', onEvent); };

  const fail = async (error) => {
    if (completed) return;
    completed = true;
    run.status = 'failed';
    if (run.turnId) database.updateTurn({ turnId: run.turnId, assistantText: run.assistantText, status: run.status, error: error.message });
    publishRun(run, 'error', { message: error.message });
    const html = await renderMarkdown(run.context.cwd, run.context.markdownBase, run.assistantText, run.context.sourceId || '').catch(() => '');
    publishRun(run, 'final', { text: run.assistantText, html, status: run.status, error: error.message });
    cleanup();
    finishRun(run);
  };

  const processEvent = async (message) => {
    const params = message.params || {};
    const eventThreadId = params.threadId || params.thread?.threadId || params.turn?.threadId;
    const eventTurnId = params.turnId || params.turn?.id;
    if (eventThreadId && eventThreadId !== run.threadId) return;
    if (run.turnId && eventTurnId && eventTurnId !== run.turnId) return;

    if (message.method === 'item/agentMessage/delta') {
      if (!run.firstDeltaAt) {
        run.firstDeltaAt = Date.now();
        publishRun(run, 'metrics', { firstDeltaMs: run.firstDeltaAt - run.startedAt });
      }
      const itemId = params.itemId || null;
      if (itemId && run.lastAgentItemId && itemId !== run.lastAgentItemId && run.assistantText) {
        const separator = run.assistantText.endsWith('\n\n') ? '' : run.assistantText.endsWith('\n') ? '\n' : '\n\n';
        if (separator) { run.assistantText += separator; publishRun(run, 'delta', { text: separator }); }
      }
      if (itemId) run.lastAgentItemId = itemId;
      const delta = String(params.delta || '');
      run.assistantText += delta;
      publishRun(run, 'delta', { text: delta });
      database.updateTurn({ turnId: run.turnId, assistantText: run.assistantText, status: run.status });
      return;
    }
    if (message.method === 'item/reasoning/summaryTextDelta') { publishRun(run, 'reasoning', { text: String(params.delta || '') }); return; }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const activity = activityForItem(params.item, message.method === 'item/completed');
      if (activity) publishRun(run, 'activity', activity);
      return;
    }
    if (message.method === 'turn/started') { publishRun(run, 'activity', { phase: 'turn', label: 'Codex 已开始处理' }); return; }
    if (message.method === 'turn/plan/updated') { publishRun(run, 'plan', { plan: params.plan || [] }); return; }
    if (message.method === 'error') { publishRun(run, 'error', { message: params.error?.message || params.message || 'Codex 执行失败' }); return; }
    if (!completed && !finishing && message.method === 'turn/completed' && (!eventTurnId || eventTurnId === run.turnId)) {
      finishing = true;
      run.status = params.turn?.status || 'completed';
      const errorText = params.turn?.error?.message || null;
      database.updateTurn({ turnId: run.turnId, assistantText: run.assistantText, status: run.status, error: errorText });
      const html = await renderMarkdown(run.context.cwd, run.context.markdownBase, run.assistantText, run.context.sourceId || '');
      completed = true;
      publishRun(run, 'final', { text: run.assistantText, html, status: run.status, error: errorText, firstDeltaMs: run.firstDeltaAt ? run.firstDeltaAt - run.startedAt : null });
      cleanup();
      finishRun(run);
    }
  };

  const onEvent = (message) => {
    const params = message.params || {};
    const eventThreadId = params.threadId || params.thread?.threadId || params.turn?.threadId;
    if (eventThreadId && eventThreadId !== run.threadId) return;
    if (!run.turnId) { earlyEvents.push(message); return; }
    processEvent(message).catch((error) => fail(error));
  };

  try {
    publishRun(run, 'activity', { phase: 'connection', label: '正在连接 Codex App Server', detail: '检查服务与永久上下文' });
    const thread = await ensureThread(session, run.context);
    run.threadId = thread.threadId;
    publishRun(run, 'activity', { phase: 'context', label: thread.restored ? '永久上下文已恢复' : '永久上下文已创建' });
    if (run.cancelRequested) { completed = true; run.status = 'interrupted'; publishRun(run, 'final', { text: '', html: '', status: run.status }); cleanup(); finishRun(run); return; }
    codex.on('event', onEvent);
    const scopePrompt = run.context.scope === 'workspace'
      ? ['当前是 MainWorker 个人工作台的主对话。', `当前工作目录：${projectRoot}`, '结合长期线程上下文处理用户请求。']
      : run.context.scope === 'articles'
        ? [`当前是文章来源“${run.context.sourceName}”的项目级持久化对话。`, `文章库目录：${run.context.cwd}`, '请从整个文章库范围理解任务。']
        : [`当前文章来源：${run.context.sourceName}`, `当前工作台文章：${run.context.articlePath}`, '这是该文章的持久化审核对话，请结合此前上下文处理。'];
    const prompt = [...scopePrompt, '用户请求：', run.userText].join('\n\n');
    const turn = await codex.startTurn(run.threadId, prompt, run.context);
    run.turnId = turn.id;
    database.createTurn({ sessionId: run.sessionId, threadId: run.threadId, turnId: run.turnId, userText: run.userText });
    persistPendingEvents(run);
    publishRun(run, 'meta', { runId: run.id, sessionId: run.sessionId, threadId: run.threadId, turnId: run.turnId });
    for (const event of earlyEvents.splice(0)) { await processEvent(event); if (completed) break; }
    if (run.cancelRequested && !completed) await codex.interruptTurn(run.threadId, run.turnId, run.context.cwd);
  } catch (error) {
    await fail(error);
  }
}

async function startChat(request, response) {
  const body = await readJson(request);
  const context = resolveChatContext(body.scope, body.articlePath, body.sourceId);
  const sessionId = positiveId(body.sessionId);
  if (!sessionId) return sendError(response, 400, '会话编号无效');
  const session = database.getSession(context.scope, context.key, sessionId);
  if (!session) return sendError(response, 404, '会话不存在');
  const userText = String(body.message || '').trim();
  if (!userText) return sendError(response, 400, '消息不能为空');
  if (userText.length > 20_000) return sendError(response, 400, '消息过长');
  if (activeRunsBySession.has(sessionId)) return sendError(response, 409, '这个会话已有正在执行的任务');
  const run = {
    id: crypto.randomUUID(), sessionId, context, userText, threadId: null, turnId: null,
    assistantText: '', status: 'inProgress', startedAt: Date.now(), firstDeltaAt: null,
    lastAgentItemId: null, seq: 0, events: [], subscribers: new Set(), cancelRequested: false,
  };
  activeRunsBySession.set(sessionId, run);
  activeRunsById.set(run.id, run);
  openSse(response);
  subscribeRun(run, response);
  publishRun(run, 'run', { runId: run.id, sessionId, scope: context.scope, articlePath: context.articlePath, sourceId: context.sourceId, startedAt: run.startedAt });
  executeRun(run, session).catch((error) => { publishRun(run, 'error', { message: error.message }); finishRun(run); });
}

async function reconnectChat(response, url) {
  const context = resolveChatContext(url.searchParams.get('scope'), url.searchParams.get('article'), url.searchParams.get('source'));
  const sessionId = positiveId(url.searchParams.get('session'));
  if (!sessionId || !database.getSession(context.scope, context.key, sessionId)) return sendError(response, 404, '会话不存在');
  const afterSeq = Math.max(0, Number(url.searchParams.get('after') || 0));
  const run = activeRunsById.get(String(url.searchParams.get('runId') || ''));
  if (run && run.sessionId === sessionId && run.context.scope === context.scope && run.context.key === context.key) {
    openSse(response);
    subscribeRun(run, response);
    const replay = run.turnId ? database.listEvents(run.turnId, afterSeq) : run.events.filter((event) => event.seq > afterSeq);
    for (const entry of replay) sendSse(response, entry.event, entry.payload);
    sendSse(response, 'snapshot', { ...publicRun(run), text: run.assistantText });
    return;
  }
  const turnId = String(url.searchParams.get('turnId') || '');
  const turn = turnId ? database.getTurn(sessionId, turnId) : null;
  if (!turn) return sendError(response, 404, '运行中的任务不存在或已经结束');
  openSse(response);
  for (const entry of database.listEvents(turn.turn_id, afterSeq)) sendSse(response, entry.event, entry.payload);
  const html = await renderMarkdown(context.cwd, context.markdownBase, turn.assistant_text, context.sourceId || '');
  sendSse(response, 'final', { text: turn.assistant_text, html, status: turn.status, error: turn.error });
  response.end();
}

async function serveFile(response, absolutePath, cache = false) {
  try {
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) return sendError(response, 404, '文件不存在');
    response.statusCode = 200;
    response.setHeader('Content-Type', MIME_TYPES[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Cache-Control', cache ? 'public, max-age=31536000, immutable' : 'no-store');
    fs.createReadStream(absolutePath).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(response, 404, '文件不存在');
    throw error;
  }
}

async function requestHandler(request, response) {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, activeRuns: activeRunsById.size });

  if (request.method === 'POST' && url.pathname === '/api/session') {
    if (!verifySameOrigin(request)) return sendError(response, 403, '来源校验失败');
    const limit = checkLoginLimit(request);
    if (!limit.allowed) { response.setHeader('Retry-After', limit.retryAfter); return sendError(response, 429, '尝试次数过多，请稍后再试'); }
    const body = await readJson(request, 4096);
    if (!auth.verifyToken(body.token)) { recordLoginFailure(limit.key); return sendError(response, 401, '访问口令错误'); }
    loginAttempts.delete(limit.key);
    auth.setSession(response, request);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/session') {
    if (!verifySameOrigin(request)) return sendError(response, 403, '来源校验失败');
    auth.clearSession(response);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/session/status') return sendJson(response, 200, { authenticated: auth.isAuthenticated(request) });

  const protectedPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/content/');
  if (protectedPath && !auth.isAuthenticated(request)) return sendError(response, 401, '请先登录');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !verifySameOrigin(request)) return sendError(response, 403, '来源校验失败');

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(response, 200, { workspaceName: path.basename(projectRoot), articleRoot, articleSources: content.listSources(), codexConnected: codex.connected });
  }
  if (request.method === 'GET' && url.pathname === '/api/account/limits') {
    const result = await rateLimits.read();
    response.setHeader('Cache-Control', 'private, no-store');
    return sendJson(response, 200, publicRateLimits(result));
  }
  if (request.method === 'POST' && url.pathname === '/api/account/limits/refresh') {
    const result = await rateLimits.read({ force: true });
    response.setHeader('Cache-Control', 'private, no-store');
    return sendJson(response, 200, publicRateLimits(result));
  }
  if (request.method === 'GET' && url.pathname === '/api/articles') {
    const activity = database.listArticleActivity();
    const query = String(url.searchParams.get('query') || '').slice(0, 200);
    const sourceId = String(url.searchParams.get('source') || 'all');
    const articles = (await content.listArticles(query, sourceId)).map((article) => ({ ...article, lastOpenedAt: activity.get(article.key) || article.updatedAt })).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
    return sendJson(response, 200, { articles });
  }
  if (request.method === 'GET' && url.pathname === '/api/article/status') {
    return sendJson(response, 200, await content.statArticle(url.searchParams.get('source'), url.searchParams.get('path')));
  }
  if (request.method === 'GET' && url.pathname === '/api/article') {
    const article = await content.readArticle(url.searchParams.get('source'), url.searchParams.get('path'));
    const opened = url.searchParams.get('opened') === '1' ? database.markArticleOpened(article.key) : database.listArticleActivity().get(article.key) || article.updatedAt;
    return sendJson(response, 200, { ...article, lastOpenedAt: opened });
  }
  if (request.method === 'GET' && url.pathname === '/api/chat/sessions') {
    const context = resolveChatContext(url.searchParams.get('scope'), url.searchParams.get('article'), url.searchParams.get('source'));
    return sendJson(response, 200, { sessions: database.listSessions(context.scope, context.key).map(publicSession) });
  }
  if (request.method === 'POST' && url.pathname === '/api/chat/sessions') {
    const body = await readJson(request, 4096);
    const context = resolveChatContext(body.scope, body.articlePath, body.sourceId);
    return sendJson(response, 201, { session: publicSession(database.createSession(context.scope, context.key)) });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/chat/sessions') {
    const body = await readJson(request, 4096);
    const context = resolveChatContext(body.scope, body.articlePath, body.sourceId);
    const sessionId = positiveId(body.sessionId);
    const session = sessionId && database.getSession(context.scope, context.key, sessionId);
    if (!session) return sendError(response, 404, '会话不存在');
    if (activeRunsBySession.has(sessionId)) return sendError(response, 409, '运行中的会话不能删除');
    database.deleteSession(context.scope, context.key, sessionId);
    if (session.thread_id) {
      void codex.deleteThread(session.thread_id, context.cwd).catch((error) => {
        console.warn(`本地会话 ${sessionId} 已删除，但 Codex 线程清理失败: ${error.message}`);
      });
    }
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/chat/history') {
    const context = resolveChatContext(url.searchParams.get('scope'), url.searchParams.get('article'), url.searchParams.get('source'));
    const sessionId = positiveId(url.searchParams.get('session'));
    const session = sessionId && database.getSession(context.scope, context.key, sessionId);
    if (!session) return sendError(response, 404, '会话不存在');
    const turns = await Promise.all(database.listTurns(sessionId).map(async (turn) => ({
      ...turn,
      assistantHtml: turn.assistant_text ? await renderMarkdown(context.cwd, context.markdownBase, turn.assistant_text, context.sourceId || '') : '',
    })));
    return sendJson(response, 200, { session: publicSession(session), threadId: session.thread_id, turns, activeRun: activeRunsBySession.has(sessionId) ? publicRun(activeRunsBySession.get(sessionId)) : null });
  }
  if (request.method === 'POST' && url.pathname === '/api/chat') return startChat(request, response);
  if (request.method === 'GET' && url.pathname === '/api/chat/stream') return reconnectChat(response, url);
  if (request.method === 'POST' && url.pathname === '/api/chat/interrupt') {
    const body = await readJson(request, 4096);
    const run = activeRunsById.get(String(body.runId || ''));
    if (!run) return sendError(response, 404, '运行中的任务不存在或已经结束');
    run.cancelRequested = true;
    publishRun(run, 'activity', { phase: 'interrupt', label: '正在停止任务' });
    if (run.threadId && run.turnId) await codex.interruptTurn(run.threadId, run.turnId, run.context.cwd);
    return sendJson(response, 200, { ok: true, pending: !run.turnId });
  }
  if (request.method === 'GET' && url.pathname === '/api/quick-phrases') return sendJson(response, 200, { phrases: database.listQuickPhrases().map((p) => ({ id: Number(p.id), text: p.phrase_text })) });
  if (request.method === 'POST' && url.pathname === '/api/quick-phrases') {
    const body = await readJson(request, 4096);
    const text = String(body.text || '').trim();
    if (!text || text.length > 500) return sendError(response, 400, '快捷短语长度无效');
    const phrase = database.createQuickPhrase(text);
    if (!phrase) return sendError(response, 409, '快捷短语已存在');
    return sendJson(response, 201, { phrase: { id: Number(phrase.id), text: phrase.phrase_text } });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/quick-phrases') {
    const body = await readJson(request, 4096);
    const id = positiveId(body.id);
    if (!id || !database.deleteQuickPhrase(id)) return sendError(response, 404, '快捷短语不存在');
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/planner/tasks') return sendJson(response, 200, { tasks: database.listTasks().map(publicTask) });
  if (request.method === 'POST' && url.pathname === '/api/planner/tasks') {
    const body = await readJson(request, 8192);
    const title = String(body.title || '').trim();
    if (!title || title.length > 240) return sendError(response, 400, '任务标题不能为空且不能超过 240 字');
    const parentId = body.parentId == null ? null : positiveId(body.parentId);
    if (body.parentId != null && !parentId) return sendError(response, 400, '父任务编号无效');
    if (parentId && !database.getTask(parentId)) return sendError(response, 404, '父任务不存在');
    return sendJson(response, 201, { task: publicTask(database.createTask({ ...body, title, parentId })) });
  }
  const taskMatch = url.pathname.match(/^\/api\/planner\/tasks\/(\d+)$/);
  if (taskMatch && request.method === 'PATCH') {
    const id = positiveId(taskMatch[1]);
    const body = await readJson(request, 8192);
    if (body.title !== undefined && !String(body.title).trim()) return sendError(response, 400, '任务标题不能为空');
    if (body.status !== undefined && !['inbox', 'todo', 'doing', 'done'].includes(body.status)) return sendError(response, 400, '任务状态无效');
    if (body.priority !== undefined && !['low', 'medium', 'high'].includes(body.priority)) return sendError(response, 400, '优先级无效');
    const task = database.updateTask(id, { ...body, ...(body.title !== undefined ? { title: String(body.title).trim() } : {}) });
    if (!task) return sendError(response, 404, '任务不存在');
    return sendJson(response, 200, { task: publicTask(task) });
  }
  if (taskMatch && request.method === 'DELETE') {
    if (!database.deleteTask(positiveId(taskMatch[1]))) return sendError(response, 404, '任务不存在');
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/content/')) {
    const requestedPath = decodeURIComponent(url.pathname.slice('/content/'.length));
    const segments = requestedPath.split('/');
    const sourceId = articleSourceIds.has(segments[0]) ? segments.shift() : defaultArticleSourceId;
    return serveFile(response, content.resolveAsset(sourceId, segments.join('/')));
  }
  if (request.method === 'GET' && url.pathname.startsWith('/vendor/katex/')) {
    const katexRoot = path.join(projectRoot, 'node_modules', 'katex', 'dist');
    const absolute = path.resolve(katexRoot, url.pathname.slice('/vendor/katex/'.length));
    const relative = path.relative(katexRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return sendError(response, 404, '资源不存在');
    return serveFile(response, absolute, true);
  }

  if (request.method === 'GET' && fs.existsSync(staticRoot)) {
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    let absolute = path.resolve(staticRoot, requested);
    const relative = path.relative(staticRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return sendError(response, 404, '页面不存在');
    if (!fs.existsSync(absolute)) absolute = path.join(staticRoot, 'index.html');
    return serveFile(response, absolute, path.extname(absolute) !== '.html');
  }
  sendError(response, 404, '接口不存在');
}

const server = http.createServer((request, response) => {
  requestHandler(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) sendError(response, 500, error.message || '服务器错误');
    else if (!response.writableEnded) response.end();
  });
});

server.listen(port, host, () => {
  console.log(`MainWorker API: http://${host}:${port}`);
  console.log(auth.tokenSource === 'environment' ? '访问口令来源: WORKBENCH_TOKEN' : `访问口令文件: ${auth.tokenFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const run of activeRunsById.values()) {
      run.status = 'interrupted';
      if (run.turnId) database.updateTurn({ turnId: run.turnId, assistantText: run.assistantText, status: run.status, error: '工作台服务已停止' });
      finishRun(run);
    }
    codex.stop();
    server.close(() => process.exit(0));
  });
}
