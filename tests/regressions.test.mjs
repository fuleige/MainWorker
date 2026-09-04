import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../server/codex-client.js';
import { ContentRepository, renderMarkdown } from '../server/content.js';
import { WorkbenchDatabase } from '../server/db.js';
import { normalizeCodeLanguage, withCodeLineMarkup } from '../lib/code-highlight.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('deleting an older conversation preserves the other sessions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainworker-db-test-'));
  const database = new WorkbenchDatabase(directory);
  try {
    const older = database.createSession('workspace', 'workspace');
    const newer = database.createSession('workspace', 'workspace');
    database.attachThread(older.id, 'thread-old');
    database.createTurn({ sessionId: older.id, threadId: 'thread-old', turnId: 'turn-old', userText: '历史消息' });
    database.updateTurn({ turnId: 'turn-old', assistantText: '历史回复', status: 'completed' });

    assert.equal(database.deleteSession('workspace', 'workspace', older.id), true);
    assert.equal(database.listTurns(older.id).length, 0);
    assert.deepEqual(database.listSessions('workspace', 'workspace').map((session) => Number(session.id)), [Number(newer.id)]);
  } finally {
    database.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat mode and model settings persist with a safe legacy migration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainworker-session-settings-test-'));
  const databasePath = path.join(directory, 'mainworker.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      context_key TEXT NOT NULL,
      thread_id TEXT UNIQUE,
      title TEXT NOT NULL DEFAULT '新会话',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO chat_sessions(scope, context_key) VALUES ('workspace', 'workspace');
  `);
  legacy.close();

  const database = new WorkbenchDatabase(directory);
  try {
    const migrated = database.getSession('workspace', 'workspace', 1);
    assert.equal(migrated.mode, 'work');
    assert.equal(migrated.model, null);
    assert.equal(migrated.reasoning_effort, null);

    const quick = database.createSession('workspace', 'workspace', 'quick');
    database.updateSessionSettings(quick.id, 'gpt-5.6-luna', 'medium');
    const restored = database.getSession('workspace', 'workspace', quick.id);
    assert.equal(restored.mode, 'quick');
    assert.equal(restored.model, 'gpt-5.6-luna');
    assert.equal(restored.reasoning_effort, 'medium');
  } finally {
    database.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('quick conversations retain web search while disabling local agent tools', async () => {
  const client = new CodexAppServerClient();
  const context = { cwd: projectRoot };
  const settings = { mode: 'quick', model: 'gpt-5.6-sol', reasoningEffort: 'low' };
  const options = client.threadOptions(context, settings);

  assert.equal(options.model, 'gpt-5.6-sol');
  assert.equal(options.sandbox, 'read-only');
  assert.equal(options.config.web_search, 'live');
  assert.equal(options.config.model_reasoning_effort, 'low');
  assert.equal(options.config.tools.web_search.context_size, 'low');
  assert.equal(options.config.tools.view_image, false);
  assert.equal(options.config.features.shell_tool, false);
  assert.equal(options.config.features.unified_exec, false);
  assert.equal(options.config.features.plugins, false);
  assert.equal(options.config.features.multi_agent, false);

  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: 'thread-quick' } };
    return { turn: { id: 'turn-quick' } };
  };
  await client.startTurn('thread-quick', '今天有什么新闻？', context, settings);
  const turnStart = calls.find((call) => call.method === 'turn/start');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: true });
  assert.equal(turnStart.params.model, 'gpt-5.6-sol');
  assert.equal(turnStart.params.effort, 'low');
});

test('planner tasks support persisted parent-child relationships', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainworker-planner-test-'));
  const database = new WorkbenchDatabase(directory);
  try {
    const parent = database.createTask({ title: '学习方向', status: 'todo', priority: 'high' });
    const child = database.createTask({ title: '第一阶段', parentId: Number(parent.id), status: 'todo', priority: 'medium' });

    assert.equal(Number(child.parent_id), Number(parent.id));
    assert.equal(database.listTasks().length, 2);
    assert.equal(database.deleteTask(Number(parent.id)), true);
    assert.equal(database.listTasks().length, 0);
  } finally {
    database.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat layout keeps the composer fixed while messages scroll independently', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  assert.match(css, /\.chat-workspace\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.chat-surface\s*\{[^}]*grid-template-rows:[^;}]*minmax\(0,1fr\)[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.message-stage\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.chat-surface\s*\{[^}]*--chat-content-width:\s*960px/s);
  assert.match(css, /\.message-thread\s*\{[^}]*width:\s*min\(var\(--chat-content-width\),\s*100%\)/s);
  assert.match(css, /\.composer\s*\{[^}]*width:\s*min\(var\(--chat-content-width\),\s*100%\)/s);
  assert.doesNotMatch(chat, /scrollIntoView/);
  assert.match(chat, /const movedUp = stage\.scrollTop < lastScrollTop\.current - 1/);
  assert.match(chat, /if \(movedUp\) followLatest\.current = false/);
  assert.match(chat, /className="scroll-to-bottom"[\s\S]*回到底部/);
  assert.match(css, /\.message-stage-shell\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.composer\s*\{[^}]*max-height:\s*min\(42dvh,\s*320px\);[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.composer textarea\s*\{[^}]*max-height:\s*min\(32dvh,\s*240px\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.composer textarea\s*\{[^}]*max-height:\s*min\(25dvh,\s*150px\);/s);
});

test('article columns have independent bounded scroll containers', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  assert.match(css, /\.articles-module\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.article-library\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.article-reader\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.article-chat\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.markdown-body table\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
});

test('the interface and markdown use a stable typography scale', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  assert.match(css, /\/\* Unified typography scale \*\//);
  assert.match(css, /\.markdown-body h1\s*\{\s*font-size:\s*24px;/);
  assert.match(css, /\.article-markdown h1\s*\{\s*font-size:\s*28px;/);
  assert.match(css, /\.article-chat \.markdown-body h1\s*\{\s*font-size:\s*19px;/);
  assert.match(css, /\.article-item em\s*\{\s*font-size:\s*10px;/);
});

test('in-progress assistant replies render tolerant streaming markdown', () => {
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  const streaming = fs.readFileSync(path.join(projectRoot, 'components/streaming-markdown.tsx'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.match(chat, /<StreamingMarkdown source=\{message\.text\} \/>/);
  assert.match(streaming, /useDeferredValue\(source\)/);
  assert.match(streaming, /stabilizeOpenCodeFence\(deferredSource\)/);
  assert.match(streaming, /components=\{\{ code: StreamingCode \}\}[\s\S]*skipHtml/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/cpp/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/python/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/java/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/yaml/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/bash/);
  assert.equal(pkg.dependencies['react-markdown'], '^10.1.0');
  assert.equal(pkg.dependencies['remark-gfm'], '^4.0.1');
});

test('code highlighting normalizes common aliases and preserves multiline spans', () => {
  assert.equal(normalizeCodeLanguage('c++'), 'cpp');
  assert.equal(normalizeCodeLanguage('py'), 'python');
  assert.equal(normalizeCodeLanguage('yml'), 'yaml');
  assert.equal(normalizeCodeLanguage('sh'), 'bash');
  assert.equal(normalizeCodeLanguage('shell'), 'bash');
  assert.equal(normalizeCodeLanguage('shellscript'), 'bash');
  const markup = withCodeLineMarkup('<span class="hljs-comment">first\nsecond</span>');
  assert.equal(markup, '<span class="code-line"><span class="hljs-comment">first</span></span><span class="code-line"><span class="hljs-comment">second</span></span>');

  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  assert.match(css, /\.markdown-body :not\(pre\) > code \{[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/s);
  assert.match(css, /\.markdown-body pre code \{[^}]*font-size:\s*inherit;[^}]*line-height:\s*inherit;/s);
  assert.match(css, /pre:not\(:has\(\.code-line \+ \.code-line\)\) \{[^}]*padding:\s*12px 14px;/s);
  assert.match(css, /pre:not\(:has\(\.code-line \+ \.code-line\)\) \.code-line::before \{[^}]*display:\s*none;/s);
});

test('KaTeX keeps required layout styles while unsafe inline styles stay blocked', async () => {
  const formula = String.raw`\frac{a_{n+1}}{b^2}=\sqrt{x}+\sum_{i=1}^{n}i`;
  const html = await renderMarkdown(
    projectRoot,
    'formula.md',
    `行内 $${formula}$\n\n$$\n${formula}\n$$\n\n<span style="position:fixed;top:999px;height:1em;background-image:url(https://example.com/x)">unsafe</span>\n\n<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0L1 1" onclick="alert(1)"></path></svg>`,
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /height:[\d.]+em/);
  assert.match(html, /top:-?[\d.]+em/);
  assert.match(html, /vertical-align:-?[\d.]+em/);
  assert.match(html, /<svg[^>]*viewBox="[^"]+"[^>]*preserveAspectRatio="[^"]+">/);
  assert.match(html, /<path d="[^"]+"><\/path>/);
  assert.doesNotMatch(html, /position:fixed|999px|background-image|onload|onclick/);
});

test('article headings, fragment links and task checkboxes survive safe rendering', async () => {
  const html = await renderMarkdown(
    projectRoot,
    'guide/chapter.md',
    '# 标题\n\n## 10. 插板法\n\n## 10. 插板法\n\n[答案](./answers.md#05-组合计数)\n\n- [ ] 未完成\n- [x] 已完成',
    'guide',
  );

  assert.match(html, /<h2 id="10-插板法">/);
  assert.match(html, /<h2 id="10-插板法-1">/);
  assert.match(html, /article=guide%2Fanswers\.md#05-%E7%BB%84%E5%90%88%E8%AE%A1%E6%95%B0/);
  assert.equal((html.match(/<input type="checkbox"/g) || []).length, 2);
  assert.equal((html.match(/disabled/g) || []).length, 2);
  assert.equal((html.match(/checked/g) || []).length, 1);
});

test('session rows expose deletion and article refresh does not change the mobile pane', () => {
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  const articles = fs.readFileSync(path.join(projectRoot, 'components/articles-module.tsx'), 'utf8');
  assert.match(chat, /aria-label=\{`删除会话 \$\{session\.title\}`\}/);
  assert.match(chat, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  assert.match(articles, /if \(markOpened\) \{[\s\S]*?setMobilePane\('reader'\);[\s\S]*?\}/);
  assert.match(articles, /openArticle\(current\.sourceId, current\.path, false\)/);
  assert.match(articles, /previous\?\.key === payload\.key && previous\.updatedAt === payload\.updatedAt && previous\.source === payload\.source/);
  assert.match(articles, /\/api\/article\/status\?source=/);
  assert.match(articles, /status\.updatedAt !== current\.updatedAt/);
  assert.match(articles, /reader\.scrollTop = pending\.scrollTop/);
  assert.match(articles, /target\.getBoundingClientRect\(\)\.top/);
});

test('the main chat exposes persisted quick mode, model controls, and independent sidebar toggles', () => {
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  const hook = fs.readFileSync(path.join(projectRoot, 'hooks/use-chat.ts'), 'utf8');
  const app = fs.readFileSync(path.join(projectRoot, 'components/workbench-app.tsx'), 'utf8');
  const server = fs.readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');

  assert.match(chat, /<Globe2 \/>快速问答/);
  assert.match(chat, /联网搜索 · 不访问本地文件/);
  assert.match(chat, /className="conversation-mode-switch"/);
  assert.match(chat, /<Command \/>工作模式/);
  assert.match(chat, /极高 XHigh/);
  assert.match(chat, /className="collapsed-sidebar-actions"[\s\S]*aria-label="新会话"/);
  assert.match(css, /\.scroll-to-bottom\s*\{[^}]*right:\s*max\(12px,\s*calc\(\(100% - var\(--chat-content-width\)\) \/ 2 - 52px\)\);[^}]*bottom:\s*14px/s);
  assert.doesNotMatch(css, /\.scroll-to-bottom\s*\{[^}]*left:\s*50%/s);
  assert.match(chat, /aria-label="选择模型"/);
  assert.match(chat, /aria-label="选择推理强度"/);
  assert.doesNotMatch(chat, />默认模型</);
  assert.doesNotMatch(chat, />默认强度</);
  assert.match(hook, /startNewSession = useCallback\(async \(mode: ChatMode = 'work'\)/);
  assert.match(hook, /context\.scope === 'workspace' && preferredId === undefined[\s\S]*setCurrentSession\(null\)/);
  assert.match(hook, /if \(!session\) \{[\s\S]*?\/api\/chat\/sessions[\s\S]*?mode: draftMode/);
  assert.match(hook, /method: 'PATCH'/);
  assert.match(server, /mode === 'quick' && context\.scope !== 'workspace'/);
  assert.match(server, /url\.pathname === '\/api\/chat\/models'/);
  assert.match(app, /const initialModule = requested ===[\s\S]*?: 'chat';/);
  assert.doesNotMatch(app, /mainworker:module/);
  assert.match(app, /mainworker:rail-collapsed/);
  assert.match(chat, /mainworker:chat-sidebar-collapsed/);
  assert.match(css, /\.workbench-shell\.is-rail-collapsed\s*\{[^}]*grid-template-columns:\s*34px/s);
  assert.match(css, /\.chat-workspace\.is-sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*48px/s);
});

test('article sources can list, read and render assets without legacy signature errors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainworker-content-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'articles'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'articles', 'sample.md'), '# 示例\n\n正文摘要。\n\n![图片](../assets/sample.png)\n\n```python\nprint("hello")\n```');
    fs.writeFileSync(path.join(directory, 'assets', 'sample.png'), 'image');
    const content = new ContentRepository([{ id: 'test', name: '测试文章', root: directory, articleDirectories: ['articles'] }]);

    const articles = await content.listArticles();
    assert.equal(articles.length, 1);
    assert.equal(articles[0].sourceId, 'test');
    assert.equal(articles[0].key, 'articles/sample.md');
    assert.equal(articles[0].excerpt.startsWith('示例'), false);

    const article = await content.readArticle('test', 'articles/sample.md');
    assert.doesNotMatch(article.html, /<h1[^>]*>示例<\/h1>/);
    assert.match(article.html, /\/content\/test\/assets\/sample\.png/);
    assert.match(article.html, /class="code-line"/);
    assert.match(article.html, /class="hljs-built_in"/);
    assert.equal(content.resolveAsset('test', 'assets/sample.png'), path.join(directory, 'assets', 'sample.png'));
    assert.equal((await content.statArticle('test', 'articles/sample.md')).updatedAt, article.updatedAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a handbook source can opt into listing README as its navigable table of contents', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainworker-handbook-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'handbook'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'handbook', 'README.md'), '# 手册目录\n\n[第一章](./01.md#学习目标)');
    fs.writeFileSync(path.join(directory, 'handbook', '01.md'), '# 第一章\n\n## 学习目标\n\n[返回目录](./README.md)');

    const defaultContent = new ContentRepository([{ id: 'default', root: directory, articleDirectories: ['handbook'] }]);
    assert.deepEqual((await defaultContent.listArticles()).map((article) => article.path), ['handbook/01.md']);

    const handbookContent = new ContentRepository([{ id: 'handbook', root: directory, articleDirectories: ['handbook'], includeReadme: true }]);
    const articles = await handbookContent.listArticles();
    assert.deepEqual(articles.map((article) => article.path).sort((left, right) => left.localeCompare(right)), ['handbook/01.md', 'handbook/README.md']);
    assert.match((await handbookContent.readArticle('handbook', 'handbook/01.md')).html, /article=handbook%2FREADME\.md/);
    assert.match((await handbookContent.readArticle('handbook', 'handbook/README.md')).html, /article=handbook%2F01\.md#%E5%AD%A6%E4%B9%A0%E7%9B%AE%E6%A0%87/);
    assert.match((await handbookContent.readArticle('handbook', 'handbook/01.md')).html, /<h2 id="学习目标">/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the quota module is reachable from desktop and mobile navigation without polling', () => {
  const app = fs.readFileSync(path.join(projectRoot, 'components/workbench-app.tsx'), 'utf8');
  const limits = fs.readFileSync(path.join(projectRoot, 'components/limits-module.tsx'), 'utf8');
  const server = fs.readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');
  assert.match(app, /id: 'limits'.*label: '额度'/);
  assert.match(app, /module === 'limits'.*<LimitsModule/);
  assert.doesNotMatch(limits, /setInterval[\s\S]*api<LimitsPayload>/);
  assert.match(limits, /const available = clampPercent\(100 - used\)/);
  assert.match(limits, /className="limit-progress-fill" style=\{\{ width: `\$\{available\}%` \}\}/);
  assert.match(limits, /if \(id === 'codex' \|\| name === 'codex'\) return 0;/);
  assert.match(limits, /if \(identity\.includes\('spark'\)\) return 1;/);
  assert.match(limits, /orderedLimits\.map\(\(limit\) =>/);
  assert.match(limits, /mainworker:account-limits/);
  assert.match(limits, /window\.localStorage\.setItem/);
  assert.match(limits, /hasOwnProperty\.call\(payload, 'resetCredits'\)/);
  assert.match(limits, /showingStaleWhileRefreshing/);
  assert.match(limits, /正在刷新额度/);
  assert.match(limits, /可用重置次数/);
  assert.match(limits, /payload\.resetCreditsCount != null \? \(/);
  assert.match(limits, /<strong>\{payload\.resetCreditsCount\} 次<\/strong>/);
  assert.match(limits, /resetCredits\.map\(\(credit, index\) =>/);
  assert.match(limits, /expiryDateTime\(credit\.expiresAt\)/);
  assert.match(limits, /if \(value == null\) return '到期时间未知';/);
  assert.doesNotMatch(limits, /长期有效/);
  assert.match(limits, /另有 \{missingResetCreditDetails\} 次未返回到期明细/);
  assert.doesNotMatch(limits, /当前账户未提供/);
  assert.doesNotMatch(limits, /数据状态<strong>/);
  assert.doesNotMatch(limits, /查询策略<strong>/);
  assert.doesNotMatch(limits, /className="limits-policy"/);
  assert.match(server, /resetCreditSummary\?\.availableCount/);
  assert.match(server, /resetCreditSummary\?\.credits == null/);
  assert.match(server, /resetCreditSummary\.credits\.map\(publicResetCredit\)/);
  assert.match(server, /expiresAt: credit\.expiresAt == null \? null : Number\(credit\.expiresAt\)/);
  assert.match(server, /request\.method === 'POST'.*\/api\/account\/limits\/refresh/);
});

test('API hot reload waits for active web tasks instead of interrupting itself', () => {
  const server = fs.readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');
  const watcher = fs.readFileSync(path.join(projectRoot, 'scripts/watch-api.mjs'), 'utf8');
  assert.match(server, /activeRuns: activeRunsById\.size/);
  assert.match(server, /request\.method === 'GET'.*\/api\/article\/status/);
  assert.match(watcher, /Number\(health\.activeRuns \|\| 0\) > 0/);
  assert.match(watcher, /setTimeout\(restartWhenIdle, health \? 1000 : 500\)/);
});
