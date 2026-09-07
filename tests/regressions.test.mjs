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
import { codeTextFromRenderedLines } from '../lib/code-copy.js';
import { normalizeMathDelimiters } from '../lib/markdown-math.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pngMetadata(file) {
  const image = fs.readFileSync(path.join(projectRoot, file));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20), colorType: image[25] };
}

test('the generated MainWorker browser icon stays lightweight and registered', () => {
  const layout = fs.readFileSync(path.join(projectRoot, 'app/layout.tsx'), 'utf8');
  assert.match(layout, /favicon-v2\.png[\s\S]*64x64/);
  assert.deepEqual(pngMetadata('public/favicon-v2.png'), { width: 64, height: 64, colorType: 6 });
  assert.ok(fs.statSync(path.join(projectRoot, 'public/favicon-v2.png')).size < 10_000);
  assert.doesNotMatch(layout, /apple-touch-icon-v2|mainworker-icon-(?:192|512)|site\.webmanifest/);
});

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

    const defaults = {
      work: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      quick: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    };
    assert.deepEqual(database.writeSetting('chat.defaults', defaults), defaults);
    assert.deepEqual(database.readSetting('chat.defaults'), defaults);
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
  assert.equal(client.threadOptions(context, { mode: 'quick' }).config.model_reasoning_effort, 'medium');

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

  await client.writeConfig([
    { keyPath: 'model', value: 'gpt-5.6-sol' },
    { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'replace' },
  ], context.cwd);
  const configWrite = calls.find((call) => call.method === 'config/batchWrite');
  assert.equal(configWrite.params.cwd, context.cwd);
  assert.deepEqual(configWrite.params.edits, [
    { keyPath: 'model', value: 'gpt-5.6-sol', mergeStrategy: 'upsert' },
    { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'replace' },
  ]);
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

test('iOS Chrome reloads compositor-broken history restorations without changing the mobile layout', () => {
  const recovery = fs.readFileSync(path.join(projectRoot, 'hooks/use-ios-chrome-restoration-reload.ts'), 'utf8');
  const layout = fs.readFileSync(path.join(projectRoot, 'app/layout.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(projectRoot, 'components/workbench-app.tsx'), 'utf8');
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  const server = fs.readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');

  assert.match(recovery, /CriOS\\\//);
  assert.match(recovery, /navigationType\(\) !== 'back_forward'/);
  assert.match(recovery, /event\.persisted/);
  assert.match(recovery, /history\.scrollRestoration = 'manual'/);
  assert.match(recovery, /window\.location\.reload\(\)/);
  assert.match(recovery, /ios-chrome-restoration-reload-guard/);
  assert.match(recovery, /const RELOAD_DELAY_MS = 120/);
  assert.match(layout, /entry\?\.type === 'back_forward'/);
  assert.match(layout, /data-ios-chrome-restoring/);
  assert.match(layout, /正在恢复页面…/);
  assert.match(layout, /setTimeout\(\(\) => location\.reload\(\), 120\)/);
  assert.match(layout, /html\[data-ios-chrome-restoring="true"\] body \{ opacity: 0 !important; \}/);
  assert.match(layout, /removeAttribute\('data-ios-chrome-restoring'\), 4000/);
  assert.match(app, /useIOSChromeRestorationReload\(\)/);
  assert.doesNotMatch(server, /\/api\/client-diagnostics|\[ios-viewport\]/);
  assert.doesNotMatch(recovery, /style\.transform/);
  assert.match(chat, /mainworker:composer-draft/);
  assert.match(chat, /localStorage\.setItem\(draftStorageKey, value\)/);
  assert.match(chat, /localStorage\.getItem\(draftStorageKey\)/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.workbench-shell\s*\{\s*display:\s*block;\s*padding-bottom:\s*62px;\s*\}/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.mobile-tabs\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/s);
  assert.doesNotMatch(css, /ios-viewport-offset-top/);
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
  assert.match(streaming, /stabilizeOpenCodeFence\(normalizeMathDelimiters\(deferredSource\)\)/);
  assert.match(streaming, /components=\{\{ code: StreamingCode, pre: StreamingPre \}\}[\s\S]*rehypePlugins=\{rehypePlugins\}[\s\S]*skipHtml/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/cpp/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/python/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/java/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/yaml/);
  assert.match(streaming, /highlight\.js\/lib\/languages\/bash/);
  assert.equal(pkg.dependencies['react-markdown'], '^10.1.0');
  assert.equal(pkg.dependencies['rehype-katex'], '^7.0.1');
  assert.equal(pkg.dependencies['remark-gfm'], '^4.0.1');
  assert.equal(pkg.dependencies['remark-math'], '^6.0.0');
});

test('code highlighting normalizes common aliases and preserves multiline spans', async () => {
  assert.equal(normalizeCodeLanguage('c++'), 'cpp');
  assert.equal(normalizeCodeLanguage('py'), 'python');
  assert.equal(normalizeCodeLanguage('yml'), 'yaml');
  assert.equal(normalizeCodeLanguage('sh'), 'bash');
  assert.equal(normalizeCodeLanguage('shell'), 'bash');
  assert.equal(normalizeCodeLanguage('shellscript'), 'bash');
  const markup = withCodeLineMarkup('<span class="hljs-comment">first\nsecond</span>');
  assert.equal(markup, '<span class="code-line"><span class="hljs-comment">first</span></span><span class="code-line"><span class="hljs-comment">second</span></span>');
  assert.equal(codeTextFromRenderedLines(['first', '\u200b', '  third']), 'first\n\n  third');

  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  const copyable = fs.readFileSync(path.join(projectRoot, 'components/copyable-code.tsx'), 'utf8');
  const chat = fs.readFileSync(path.join(projectRoot, 'components/chat-workspace.tsx'), 'utf8');
  assert.match(css, /\.markdown-body :not\(pre\) > code \{[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/s);
  assert.match(css, /\.markdown-body pre code \{[^}]*font-size:\s*inherit;[^}]*line-height:\s*inherit;/s);
  assert.match(css, /pre:not\(:has\(\.code-line \+ \.code-line\)\) \{[^}]*padding:\s*12px 14px;/s);
  assert.match(css, /pre:not\(:has\(\.code-line \+ \.code-line\)\) \.code-line::before \{[^}]*display:\s*none;/s);
  assert.match(css, /\.markdown-body \.code-copy-button\s*\{/);
  assert.match(copyable, /codeTextFromRenderedLines\(lines\.map/);
  assert.match(copyable, /navigator\.clipboard\?\.writeText/);
  assert.match(copyable, /document\.execCommand\('copy'\)/);
  assert.doesNotMatch(copyable, /querySelectorAll\('pre'\)|pre\.replaceWith\(frame\)/);
  assert.match(chat, /<StaticMarkdown[\s\S]*html=\{message\.html\}/);

  const codeHtml = await renderMarkdown(projectRoot, 'chat.md', '```js\nconst first = 1;\n\nconst second = 2;\n```', '', { copyableCode: true });
  assert.match(codeHtml, /<div class="code-block">/);
  assert.match(codeHtml, /<button[^>]*data-copy-code(?:="")?[^>]*>复制<\/button>/);
  assert.equal((codeHtml.match(/class="code-line"/g) || []).length, 3);
});

test('KaTeX keeps required layout styles while unsafe inline styles stay blocked', async () => {
  const formula = String.raw`\frac{a_{n+1}}{b^2}=\sqrt{x}+\sum_{i=1}^{n}i`;
  const html = await renderMarkdown(
    projectRoot,
    'formula.md',
    String.raw`行内 \(${formula}\)

\[
${formula}
\]

<span style="position:fixed;top:999px;height:1em;background-image:url(https://example.com/x)">unsafe</span>

<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0L1 1" onclick="alert(1)"></path></svg>`,
  );

  assert.equal(normalizeMathDelimiters(String.raw`行内 \(x+1\)，块级 \[y=2\]`), '行内 $x+1$，块级 $$y=2$$');
  assert.equal(normalizeMathDelimiters('`\\(x\\)`\n\n```tex\n\\[x\\]\n```'), '`\\(x\\)`\n\n```tex\n\\[x\\]\n```');
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
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  assert.match(chat, /aria-label=\{`删除会话 \$\{session\.title\}`\}/);
  assert.match(chat, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing/);
  assert.match(articles, /if \(markOpened\) \{[\s\S]*?setMobilePane\('reader'\);[\s\S]*?\}/);
  assert.match(articles, /openArticle\(current\.sourceId, current\.path, false\)/);
  assert.match(articles, /previous\?\.key === payload\.key && previous\.updatedAt === payload\.updatedAt && previous\.source === payload\.source/);
  assert.match(articles, /\/api\/article\/status\?source=/);
  assert.match(articles, /status\.updatedAt !== current\.updatedAt/);
  assert.match(articles, /const ARTICLE_CHECK_INTERVAL_MS = 30_000/);
  assert.match(articles, /上次检查[\s\S]*下次检查/);
  assert.match(articles, /reader\.scrollTop = pending\.scrollTop/);
  assert.match(articles, /target\.getBoundingClientRect\(\)\.top/);
  assert.match(articles, /function buildArticleTree\(articles: ArticleSummary\[\]\)/);
  assert.match(articles, /kind: 'project' \| 'folder'/);
  assert.match(articles, /className="article-tree-toggle"[\s\S]*aria-expanded=\{expanded\}/);
  assert.match(articles, /searching \|\| !collapsedGroups\.has\(group\.key\)/);
  assert.match(articles, /aria-label="按项目和文件夹分类的文章目录"/);
  assert.match(articles, /aria-label="搜索文章标题"/);
  assert.match(articles, /scope="article"/);
  assert.doesNotMatch(articles, /整个项目|article-scope-tabs|scope=\{scope\}/);
  assert.match(css, /\.article-tree-children\s*\{[^}]*border-left:/s);
  assert.match(css, /\.article-tree-group\.is-project > \.article-tree-toggle/);
});

test('the main chat exposes persisted quick mode, model controls, and a collapsible conversation sidebar', () => {
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
  assert.match(hook, /context\.scope === 'workspace' && preferredId == null[\s\S]*setCurrentSession\(null\)/);
  assert.match(hook, /onSessionUrlChange\?\.\(createdSession\.id, 'replace'\)/);
  assert.match(hook, /missingSessionId/);
  assert.match(hook, /if \(!session\) \{[\s\S]*?\/api\/chat\/sessions[\s\S]*?mode: draftMode/);
  assert.match(hook, /method: 'PATCH'/);
  assert.match(server, /mode === 'quick' && context\.scope !== 'workspace'/);
  assert.match(server, /url\.pathname === '\/api\/chat\/models'/);
  assert.match(server, /const MODEL_CATALOG_TTL_MS = 60 \* 60 \* 1000/);
  assert.match(server, /url\.pathname === '\/api\/chat\/models\/refresh'/);
  assert.match(app, /return Number\.isSafeInteger\(legacySession\)[\s\S]*`\/chat\/\$\{legacySession\}` : '\/chat'/);
  assert.match(app, /path\.match\(\/\^\\\/chat\(\?:\\\/\(\\d\+\)\)\?\$\//);
  assert.match(app, /onSessionUrlChange=\{changeSessionUrl\}/);
  assert.match(app, /const LAST_CHAT_HREF_KEY = 'mainworker:last-chat-href'/);
  assert.match(app, /const lastChatHref = useRef\('\/chat'\)/);
  assert.match(app, /navigate\(view === 'chat' \? lastChatHref\.current : hrefForView\(view\)\)/);
  assert.match(app, /rememberChatHref\(href\);[\s\S]*history\[mode === 'replace'/);
  assert.doesNotMatch(app, /mainworker:module/);
  assert.doesNotMatch(app, /mainworker:rail-collapsed|折叠工具栏|展开工具栏/);
  assert.match(chat, /mainworker:chat-sidebar-collapsed/);
  assert.doesNotMatch(css, /\.workbench-shell\.is-rail-collapsed|\.app-rail\.is-collapsed|\.rail-expand/);
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
    assert.equal((await content.listArticles('示例')).length, 1);
    assert.equal((await content.listArticles('正文摘要')).length, 0);
    assert.equal((await content.listArticles('sample')).length, 0);
    assert.equal((await content.listArticles('测试文章')).length, 0);

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
  const settings = fs.readFileSync(path.join(projectRoot, 'components/settings-module.tsx'), 'utf8');
  const limits = fs.readFileSync(path.join(projectRoot, 'components/limits-module.tsx'), 'utf8');
  const server = fs.readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');
  const css = fs.readFileSync(path.join(projectRoot, 'app/globals.css'), 'utf8');
  assert.match(app, /\/settings\/usage/);
  assert.match(app, /settingsSection: \(settingsMatch\[1\] \|\| 'usage'\)/);
  assert.match(settings, /const sections = \[\s*\{ id: 'usage'.*label: '用量与额度'/);
  assert.match(settings, /section === 'usage'.*<LimitsModule/);
  assert.match(settings, /const settingsLoadStarted = useRef\(false\)/);
  assert.match(settings, /const settingsLoadInFlight = useRef\(false\)/);
  assert.match(settings, /if \(settingsLoadInFlight\.current\) return/);
  assert.match(settings, /!settingsLoadStarted\.current/);
  assert.match(settings, />重新加载设置</);
  assert.match(css, /\.tool-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,minmax\(156px,176px\)\)/s);
  assert.match(css, /\.tool-card\s*\{[^}]*min-height:\s*176px;[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.settings-nav nav\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.match(css, /\.settings-nav nav::-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(limits, /setInterval[\s\S]*api<LimitsPayload>/);
  assert.match(limits, /const available = clampPercent\(100 - used\)/);
  assert.match(limits, /if \(minutes === 7 \* 1440\) return '周额度';/);
  assert.match(limits, /return `\$\{minutes \/ 60\} 小时额度`/);
  assert.match(limits, /fallbackTitle="短期额度"/);
  assert.match(limits, /fallbackTitle="长期额度"/);
  assert.doesNotMatch(limits, /主要额度|补充额度/);
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
