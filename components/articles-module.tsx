'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpenText, ChevronRight, FileText, Folder, FolderOpen, LoaderCircle, MessageSquareText, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/workbench-api';
import { ChatWorkspace } from '@/components/chat-workspace';

type ArticleSummary = {
  key: string;
  sourceId: string;
  sourceName: string;
  path: string;
  title: string;
  excerpt: string;
  characters: number;
  updatedAt: string;
  lastOpenedAt: string;
};

type Article = ArticleSummary & { html: string; source: string };
type ArticleSync = {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextAt: number | null;
  status: 'scheduled' | 'checking' | 'paused' | 'error';
  error: string;
};

const ARTICLE_CHECK_INTERVAL_MS = 30_000;

type ArticleTreeGroup = {
  key: string;
  name: string;
  kind: 'project' | 'folder';
  count: number;
  folders: ArticleTreeGroup[];
  articles: ArticleSummary[];
};

type MutableArticleTreeGroup = Omit<ArticleTreeGroup, 'folders'> & {
  folderMap: Map<string, MutableArticleTreeGroup>;
};

function createArticleTreeGroup(key: string, name: string, kind: ArticleTreeGroup['kind']): MutableArticleTreeGroup {
  return { key, name, kind, count: 0, folderMap: new Map(), articles: [] };
}

function finalizeArticleTreeGroup(group: MutableArticleTreeGroup): ArticleTreeGroup {
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  return {
    key: group.key,
    name: group.name,
    kind: group.kind,
    count: group.count,
    folders: [...group.folderMap.values()]
      .sort((left, right) => collator.compare(left.name, right.name))
      .map(finalizeArticleTreeGroup),
    articles: [...group.articles].sort((left, right) => collator.compare(left.path, right.path)),
  };
}

function buildArticleTree(articles: ArticleSummary[]) {
  const projects = new Map<string, MutableArticleTreeGroup>();
  for (const article of articles) {
    let project = projects.get(article.sourceId);
    if (!project) {
      project = createArticleTreeGroup(`project:${article.sourceId}`, article.sourceName, 'project');
      projects.set(article.sourceId, project);
    }
    project.count += 1;
    let group: MutableArticleTreeGroup = project;
    const folders = article.path.split('/').filter(Boolean).slice(0, -1);
    let folderPath = '';
    for (const folderName of folders) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      let folder: MutableArticleTreeGroup | undefined = group.folderMap.get(folderName);
      if (!folder) {
        folder = createArticleTreeGroup(`folder:${article.sourceId}:${folderPath}`, folderName, 'folder');
        group.folderMap.set(folderName, folder);
      }
      folder.count += 1;
      group = folder;
    }
    group.articles.push(article);
  }
  return [...projects.values()].map(finalizeArticleTreeGroup);
}

function articleFileName(articlePath: string) {
  return articlePath.split('/').at(-1) || articlePath;
}

function ArticleTreeGroupView({
  group, currentKey, collapsedGroups, searching, onToggle, onOpen,
}: {
  group: ArticleTreeGroup;
  currentKey: string | null;
  collapsedGroups: Set<string>;
  searching: boolean;
  onToggle: (key: string) => void;
  onOpen: (article: ArticleSummary) => void;
}) {
  const expanded = searching || !collapsedGroups.has(group.key);
  return (
    <section className={`article-tree-group is-${group.kind}`}>
      <button className="article-tree-toggle" type="button" onClick={() => onToggle(group.key)} aria-expanded={expanded}>
        <ChevronRight className={expanded ? 'is-expanded' : ''} />
        {expanded ? <FolderOpen /> : <Folder />}
        <span>{group.name}</span>
        <small>{group.count}</small>
      </button>
      {expanded ? (
        <div className="article-tree-children">
          {group.folders.map((folder) => (
            <ArticleTreeGroupView
              key={folder.key}
              group={folder}
              currentKey={currentKey}
              collapsedGroups={collapsedGroups}
              searching={searching}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
          {group.articles.map((article) => (
            <button className={`article-item ${currentKey === article.key ? 'is-active' : ''}`} type="button" key={article.key} onClick={() => onOpen(article)} title={article.path}>
              <span className="article-item-icon"><FileText /></span>
              <span><strong>{article.title}</strong><small>{article.excerpt || '暂无摘要'}</small><em>{articleFileName(article.path)}</em></span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function decodeAnchor(value: string) {
  const encoded = value.replace(/^#/, '');
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function clockTime(value: number | null) {
  if (!value) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

export function ArticlesModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [current, setCurrent] = useState<Article | null>(null);
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [mobilePane, setMobilePane] = useState<'library' | 'reader' | 'chat'>('reader');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const articleReader = useRef<HTMLElement>(null);
  const pendingReaderPosition = useRef<{ scrollTop: number; anchor: string } | null>(null);
  const refreshInFlight = useRef(false);
  const [sync, setSync] = useState<ArticleSync>({ lastAttemptAt: null, lastSuccessAt: null, nextAt: null, status: 'scheduled', error: '' });
  const currentKey = current?.key || null;
  const articleTree = useMemo(() => buildArticleTree(articles), [articles]);

  const openArticle = useCallback(async (sourceId: string, path: string, markOpened = true, anchor = '') => {
    const normalizedAnchor = decodeAnchor(anchor);
    pendingReaderPosition.current = {
      scrollTop: markOpened ? 0 : articleReader.current?.scrollTop ?? 0,
      anchor: normalizedAnchor,
    };
    try {
      const payload = await api<Article>(`/api/article?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}${markOpened ? '&opened=1' : ''}`);
      setCurrent((previous) => {
        if (!markOpened && previous?.key === payload.key && previous.updatedAt === payload.updatedAt && previous.source === payload.source) return previous;
        return payload;
      });
      setError('');
      if (markOpened) {
        const params = new URLSearchParams(location.search);
        params.delete('module');
        params.set('source', payload.sourceId);
        params.set('article', payload.path);
        history.replaceState(null, '', `/tools/articles?${params}${normalizedAnchor ? `#${encodeURIComponent(normalizedAnchor)}` : ''}`);
        setMobilePane('reader');
      }
    } catch (error) {
      if ((error as { status?: number }).status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : '文章读取失败');
    }
  }, [onUnauthorized]);

  useLayoutEffect(() => {
    const pending = pendingReaderPosition.current;
    const reader = articleReader.current;
    if (!pending || !reader) return;
    const target = pending.anchor ? document.getElementById(pending.anchor) : null;
    if (target && reader.contains(target)) {
      const readerTop = reader.getBoundingClientRect().top;
      reader.scrollTop = Math.max(0, reader.scrollTop + target.getBoundingClientRect().top - readerTop - 58);
    } else {
      reader.scrollTop = pending.scrollTop;
    }
    pendingReaderPosition.current = null;
  }, [current]);

  const loadArticles = useCallback(async (search = '') => {
    try {
      const payload = await api<{ articles: ArticleSummary[] }>(`/api/articles${search ? `?query=${encodeURIComponent(search)}` : ''}`);
      setArticles(payload.articles);
      setError('');
      if (!currentKey && payload.articles.length) {
        const params = new URLSearchParams(location.search);
        const requested = params.get('article');
        const requestedSource = params.get('source');
        const initial = payload.articles.find((item) => item.path === requested && (!requestedSource || item.sourceId === requestedSource)) || payload.articles[0];
        const anchor = requested && initial.path === requested ? location.hash : '';
        await openArticle(initial.sourceId, initial.path, true, anchor);
      }
    } catch (error) {
      if ((error as { status?: number }).status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : '文章列表读取失败');
    } finally {
      setLoading(false);
    }
  }, [currentKey, onUnauthorized, openArticle]);

  useEffect(() => { queueMicrotask(() => void loadArticles()); }, [loadArticles]);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState !== 'visible') {
        setSync((value) => ({ ...value, nextAt: null, status: 'paused' }));
        return;
      }
      const nextAt = Date.now() + ARTICLE_CHECK_INTERVAL_MS;
      setSync((value) => ({ ...value, nextAt, status: value.status === 'error' ? 'error' : 'scheduled' }));
      timer = setTimeout(() => void check(), ARTICLE_CHECK_INTERVAL_MS);
    };

    const check = async () => {
      if (cancelled || document.visibilityState !== 'visible' || refreshInFlight.current) return schedule();
      refreshInFlight.current = true;
      const attemptedAt = Date.now();
      setSync((value) => ({ ...value, lastAttemptAt: attemptedAt, nextAt: null, status: 'checking', error: '' }));
      try {
        const status = await api<{ updatedAt: string }>(`/api/article/status?source=${encodeURIComponent(current.sourceId)}&path=${encodeURIComponent(current.path)}`);
        if (!cancelled && status.updatedAt !== current.updatedAt) await openArticle(current.sourceId, current.path, false);
        if (!cancelled) setSync((value) => ({ ...value, lastSuccessAt: Date.now(), status: 'scheduled', error: '' }));
      } catch (error) {
        if ((error as { status?: number }).status === 401) onUnauthorized();
        if (!cancelled) setSync((value) => ({ ...value, status: 'error', error: error instanceof Error ? error.message : '检查失败' }));
      } finally {
        refreshInFlight.current = false;
        if (!cancelled) schedule();
      }
    };

    const onVisibilityChange = () => schedule();
    queueMicrotask(() => {
      if (cancelled) return;
      setSync({ lastAttemptAt: null, lastSuccessAt: Date.now(), nextAt: null, status: document.visibilityState === 'visible' ? 'scheduled' : 'paused', error: '' });
      schedule();
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [current, onUnauthorized, openArticle]);

  const navigateArticleLink = useCallback((event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target || link.getAttribute('href')?.startsWith('#')) return;
    const url = new URL(link.href, location.href);
    const articlePath = url.searchParams.get('article');
    const articleRoute = url.pathname === '/tools/articles' || url.searchParams.get('module') === 'articles';
    if (url.origin !== location.origin || !articleRoute || !articlePath) return;
    event.preventDefault();
    void openArticle(url.searchParams.get('source') || current?.sourceId || '', articlePath, true, url.hash);
  }, [current?.sourceId, openArticle]);

  useEffect(() => {
    const reader = articleReader.current;
    if (!reader) return;
    reader.addEventListener('click', navigateArticleLink);
    return () => reader.removeEventListener('click', navigateArticleLink);
  }, [navigateArticleLink]);

  function search(value: string) {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadArticles(value.trim()), 180);
  }

  function toggleArticleGroup(key: string) {
    if (query.trim()) return;
    setCollapsedGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);
      if (nextGroups.has(key)) nextGroups.delete(key);
      else nextGroups.add(key);
      return nextGroups;
    });
  }

  return (
    <section className={`articles-module mobile-pane-${mobilePane}`}>
      <nav className="article-mobile-nav" aria-label="文章工作区">
        <Button variant={mobilePane === 'library' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('library')}><BookOpenText />目录</Button>
        <Button variant={mobilePane === 'reader' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('reader')}><FileText />正文</Button>
        <Button variant={mobilePane === 'chat' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('chat')}><MessageSquareText />审核</Button>
      </nav>
      <aside className="article-library">
        <header className="article-library-header"><div><p className="overline">KNOWLEDGE</p><h1>文章审核</h1></div><span>{articles.length}</span></header>
        <div className="article-search"><Search /><Input aria-label="搜索文章标题" value={query} onChange={(event) => search(event.target.value)} placeholder="搜索文章标题" /></div>
        {error && <div className="article-error">{error}</div>}
        <nav className="article-list" aria-label="按项目和文件夹分类的文章目录">
          {loading ? <div className="article-list-empty"><LoaderCircle className="spin" />正在读取文章…</div> : null}
          {articleTree.map((project) => (
            <ArticleTreeGroupView
              key={project.key}
              group={project}
              currentKey={currentKey}
              collapsedGroups={collapsedGroups}
              searching={Boolean(query.trim())}
              onToggle={toggleArticleGroup}
              onOpen={(article) => void openArticle(article.sourceId, article.path)}
            />
          ))}
          {!loading && !articles.length ? <div className="article-list-empty">没有找到 Markdown 文章</div> : null}
        </nav>
      </aside>

      <article className="article-reader" ref={articleReader}>
        <header className="article-reader-bar">
          {current && <span>{current.characters.toLocaleString('zh-CN')} 字符 · {new Date(current.updatedAt).toLocaleDateString('zh-CN')}</span>}
          {current && <span className={`article-sync is-${sync.status}`} title={sync.error || undefined}>{sync.status === 'paused' ? '后台标签页，自动检查已暂停' : sync.status === 'checking' ? '正在检查更新…' : sync.status === 'error' ? `上次检查 ${clockTime(sync.lastAttemptAt)} · 检查失败 · 下次检查 ${clockTime(sync.nextAt)}` : `上次检查 ${clockTime(sync.lastAttemptAt)} · 下次检查 ${clockTime(sync.nextAt)}`}</span>}
        </header>
        {current ? (
          <div className="article-document">
            <p className="article-path">{current.sourceName} · {current.path}</p>
            <h1>{current.title}</h1>
            <div className="markdown-body article-markdown" dangerouslySetInnerHTML={{ __html: current.html }} />
          </div>
        ) : <div className="article-reader-empty"><BookOpenText /><p>选择一篇文章开始阅读和审核</p></div>}
      </article>

      <aside className="article-chat">
        <ChatWorkspace
          compact
          enabled={Boolean(current)}
          scope="article"
          sourceId={current?.sourceId}
          articlePath={current?.path}
          title={current?.title || '文章审核'}
          subtitle="独立永久上下文"
          onUnauthorized={onUnauthorized}
        />
      </aside>
    </section>
  );
}
