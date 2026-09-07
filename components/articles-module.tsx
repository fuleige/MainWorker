'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BookOpenText, Check, ChevronRight, Circle, FileText, Folder,
  LoaderCircle, MessageSquareText, RefreshCw, Search, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StaticMarkdown } from '@/components/copyable-code';
import { ChatWorkspace } from '@/components/chat-workspace';
import { ChatRunResult } from '@/hooks/use-chat';
import { api } from '@/lib/workbench-api';

type ArticleSummary = {
  key: string;
  sourceId: string;
  sourceName: string;
  path: string;
  logicalPath: string;
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
type ReviewStatus = 'idle' | 'running' | 'checked' | 'error';
type ReviewRecord = { items: Record<string, ReviewStatus>; finalCheckedAt: string | null };

const ARTICLE_CHECK_INTERVAL_MS = 30_000;
const REVIEW_ITEMS = [
  { id: 'accuracy', label: '事实准确', prompt: '逐项核对事实、术语、数字和可能过时的信息；发现问题就直接修正当前 Markdown 文件，并说明核对结果与改动。' },
  { id: 'logic', label: '逻辑一致', prompt: '检查全文论证、前后结论、概念边界和示例是否一致；发现问题就直接修正当前 Markdown 文件，并说明改动。' },
  { id: 'structure', label: '结构清晰', prompt: '检查标题层级、段落顺序、重复内容和阅读节奏；只在确有必要时直接调整当前 Markdown 文件，并说明改动。' },
  { id: 'language', label: '表达与错字', prompt: '检查病句、错别字、标点、冗余表达和术语统一；直接修正当前 Markdown 文件，并简要汇总。' },
  { id: 'references', label: '引用与链接', prompt: '检查文中的引用、链接、图片引用和来源表述是否可靠、可理解；能确认的问题直接修正当前 Markdown 文件，不能确认的明确列出。' },
  { id: 'markdown', label: 'Markdown 渲染', prompt: '检查 Markdown、代码块、表格、公式与列表语法，确保可正常渲染；直接修正当前 Markdown 文件中的格式问题并说明。' },
] as const;

function blankReview(): ReviewRecord {
  return { items: Object.fromEntries(REVIEW_ITEMS.map((item) => [item.id, 'idle'])) as Record<string, ReviewStatus>, finalCheckedAt: null };
}

function logicalPath(article: ArticleSummary) {
  return article.logicalPath || article.path;
}

function parentDirectory(articlePath: string) {
  return articlePath.split('/').filter(Boolean).slice(0, -1).join('/');
}

function articleFileName(articlePath: string) {
  return articlePath.split('/').at(-1) || articlePath;
}

function buildLogicalLevel(articles: ArticleSummary[], directory: string, query: string) {
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    const allFolders = new Map<string, { name: string; path: string; count: number }>();
    for (const article of articles) {
      const parts = logicalPath(article).split('/').filter(Boolean);
      for (let index = 0; index < parts.length - 1; index += 1) {
        const folderPath = parts.slice(0, index + 1).join('/');
        const folder = allFolders.get(folderPath) || { name: parts[index], path: folderPath, count: 0 };
        folder.count += 1;
        allFolders.set(folderPath, folder);
      }
    }
    return {
      folders: [...allFolders.values()]
        .filter((folder) => folder.name.toLowerCase().includes(normalizedQuery) || folder.path.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => collator.compare(left.path, right.path)),
      articles: articles
        .filter((article) => articleFileName(logicalPath(article)).toLowerCase().includes(normalizedQuery))
        .sort((left, right) => collator.compare(logicalPath(left), logicalPath(right))),
    };
  }
  const prefix = directory ? `${directory}/` : '';
  const folders = new Map<string, { name: string; path: string; count: number }>();
  const directArticles: ArticleSummary[] = [];
  for (const article of articles) {
    const path = logicalPath(article);
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash < 0) {
      directArticles.push(article);
      continue;
    }
    const name = remainder.slice(0, slash);
    const folderPath = prefix + name;
    const folder = folders.get(name) || { name, path: folderPath, count: 0 };
    folder.count += 1;
    folders.set(name, folder);
  }
  return {
    folders: [...folders.values()].sort((left, right) => collator.compare(left.name, right.name)),
    articles: directArticles.sort((left, right) => collator.compare(logicalPath(left), logicalPath(right))),
  };
}

function decodeAnchor(value: string) {
  const encoded = value.replace(/^#/, '');
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function clockTime(value: number | null) {
  if (!value) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function dateTime(value: string | null) {
  if (!value) return '尚未完成';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function ArticlesModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [current, setCurrent] = useState<Article | null>(null);
  const [directory, setDirectory] = useState('');
  const [query, setQuery] = useState('');
  const [mobilePane, setMobilePane] = useState<'library' | 'reader' | 'chat'>('reader');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ReviewRecord>(blankReview);
  const [pendingReview, setPendingReview] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [promptRequest, setPromptRequest] = useState<{ id: number; text: string; send: boolean } | null>(null);
  const [sync, setSync] = useState<ArticleSync>({ lastAttemptAt: null, lastSuccessAt: null, nextAt: null, status: 'scheduled', error: '' });
  const articleReader = useRef<HTMLDivElement>(null);
  const pendingReaderPosition = useRef<{ scrollTop: number; anchor: string } | null>(null);
  const initializedArticle = useRef(false);
  const refreshInFlight = useRef(false);
  const promptSequence = useRef(0);
  const currentKey = current?.key || null;
  const reviewStorageKey = current?.key || null;
  const currentLevel = useMemo(() => buildLogicalLevel(articles, directory, query), [articles, directory, query]);
  const directoryParts = directory.split('/').filter(Boolean);

  const openArticle = useCallback(async (sourceId: string, path: string, markOpened = true, anchor = '') => {
    const normalizedAnchor = decodeAnchor(anchor);
    pendingReaderPosition.current = { scrollTop: markOpened ? 0 : articleReader.current?.scrollTop ?? 0, anchor: normalizedAnchor };
    try {
      const payload = await api<Article>(`/api/article?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(path)}${markOpened ? '&opened=1' : ''}`);
      setCurrent((previous) => !markOpened && previous?.key === payload.key && previous.updatedAt === payload.updatedAt && previous.source === payload.source ? previous : payload);
      setError('');
      if (markOpened) {
        setDirectory(parentDirectory(logicalPath(payload)));
        const params = new URLSearchParams(location.search);
        params.delete('module');
        params.set('source', payload.sourceId);
        params.set('article', payload.path);
        history.replaceState(null, '', `/tools/articles?${params}${normalizedAnchor ? `#${encodeURIComponent(normalizedAnchor)}` : ''}`);
        setMobilePane('reader');
      }
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '文章读取失败');
    }
  }, [onUnauthorized]);

  const loadArticles = useCallback(async () => {
    try {
      const payload = await api<{ articles: ArticleSummary[] }>('/api/articles');
      setArticles(payload.articles);
      setError('');
      if (!initializedArticle.current && payload.articles.length) {
        initializedArticle.current = true;
        const params = new URLSearchParams(location.search);
        const requested = params.get('article');
        const requestedSource = params.get('source');
        const initial = payload.articles.find((item) => item.path === requested && (!requestedSource || item.sourceId === requestedSource)) || payload.articles[0];
        await openArticle(initial.sourceId, initial.path, true, requested && initial.path === requested ? location.hash : '');
      }
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '文章列表读取失败');
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, openArticle]);

  const reloadCurrent = useCallback(async () => {
    if (!current) return;
    await Promise.all([openArticle(current.sourceId, current.path, false), loadArticles()]);
  }, [current, loadArticles, openArticle]);

  useEffect(() => { queueMicrotask(() => void loadArticles()); }, [loadArticles]);

  useLayoutEffect(() => {
    const pending = pendingReaderPosition.current;
    const reader = articleReader.current;
    if (!pending || !reader) return;
    const target = pending.anchor ? document.getElementById(pending.anchor) : null;
    if (target && reader.contains(target)) {
      const readerTop = reader.getBoundingClientRect().top;
      reader.scrollTop = Math.max(0, reader.scrollTop + target.getBoundingClientRect().top - readerTop - 20);
    } else reader.scrollTop = pending.scrollTop;
    pendingReaderPosition.current = null;
  }, [current]);

  useEffect(() => {
    if (!reviewStorageKey) return;
    try {
      const stored = localStorage.getItem(`mainworker:article-review:${reviewStorageKey}`);
      const parsed = stored ? JSON.parse(stored) as Partial<ReviewRecord> : null;
      const next = blankReview();
      if (parsed?.items) for (const item of REVIEW_ITEMS) {
        const status = parsed.items[item.id];
        if (['idle', 'checked', 'error'].includes(status)) next.items[item.id] = status;
      }
      next.finalCheckedAt = typeof parsed?.finalCheckedAt === 'string' ? parsed.finalCheckedAt : null;
      queueMicrotask(() => setReview(next));
    } catch {
      queueMicrotask(() => setReview(blankReview()));
    }
    queueMicrotask(() => {
      setPendingReview(null);
    });
  }, [reviewStorageKey]);

  const updateReview = useCallback((updater: (previous: ReviewRecord) => ReviewRecord) => {
    setReview((previous) => {
      const next = updater(previous);
      if (currentKey) {
        try { localStorage.setItem(`mainworker:article-review:${currentKey}`, JSON.stringify(next)); } catch { /* Optional local status cache. */ }
      }
      return next;
    });
  }, [currentKey]);

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
      } catch (caught) {
        if ((caught as { status?: number }).status === 401) onUnauthorized();
        if (!cancelled) setSync((value) => ({ ...value, status: 'error', error: caught instanceof Error ? caught.message : '检查失败' }));
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
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibilityChange); };
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
  }

  function queuePrompt(text: string, send: boolean) {
    promptSequence.current += 1;
    setPromptRequest({ id: promptSequence.current, text, send });
    setMobilePane('chat');
  }

  function runReview(itemId: string) {
    if (!current || chatBusy) return;
    const item = REVIEW_ITEMS.find((entry) => entry.id === itemId);
    const isFinal = itemId === 'final';
    const prompt = isFinal
      ? '请对当前文章执行最终检查：依次核对事实准确性、逻辑一致性、结构、语言与错字、引用和链接、Markdown/代码块/表格/公式渲染。发现任何问题都直接修改当前 Markdown 文件；完成后给出简短的最终结论和修改摘要。不要只给建议。'
      : item?.prompt;
    if (!prompt) return;
    setPendingReview(itemId);
    updateReview((previous) => ({
      ...previous,
      items: isFinal
        ? Object.fromEntries(REVIEW_ITEMS.map((entry) => [entry.id, 'running'])) as Record<string, ReviewStatus>
        : { ...previous.items, [itemId]: 'running' },
    }));
    queuePrompt(prompt, true);
  }

  const handleRunComplete = useCallback((result: ChatRunResult) => {
    const completed = result.status === 'completed';
    if (pendingReview) {
      const isFinal = pendingReview === 'final';
      updateReview((previous) => ({
        items: isFinal
          ? Object.fromEntries(REVIEW_ITEMS.map((item) => [item.id, completed ? 'checked' : 'error'])) as Record<string, ReviewStatus>
          : { ...(result.articleChange ? blankReview().items : previous.items), [pendingReview]: completed ? 'checked' : 'error' },
        finalCheckedAt: isFinal && completed ? new Date().toISOString() : result.articleChange ? null : previous.finalCheckedAt,
      }));
      setPendingReview(null);
    } else if (result.articleChange) updateReview(() => blankReview());
    if (result.articleChange) void reloadCurrent();
  }, [pendingReview, reloadCurrent, updateReview]);

  const syncLabel = sync.status === 'paused'
    ? '后台中，自动检查暂停'
    : sync.status === 'checking'
      ? '正在检查更新…'
      : sync.status === 'error'
        ? `检查失败 · ${clockTime(sync.lastAttemptAt)}`
        : `上次 ${clockTime(sync.lastAttemptAt)} · 下次 ${clockTime(sync.nextAt)}`;

  return (
    <section className={`articles-module mobile-pane-${mobilePane}`}>
      <nav className="article-mobile-nav" aria-label="文章工作区">
        <Button variant={mobilePane === 'library' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('library')}><BookOpenText />目录</Button>
        <Button variant={mobilePane === 'reader' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('reader')}><FileText />正文</Button>
        <Button variant={mobilePane === 'chat' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('chat')}><MessageSquareText />审核</Button>
      </nav>

      <aside className="article-library">
        <header className="article-library-header"><div><p className="overline">KNOWLEDGE</p><h1>文章审核</h1></div><span>{articles.length}</span></header>
        <div className="article-search"><Search /><Input aria-label="全局搜索文件夹或文件名" value={query} onChange={(event) => search(event.target.value)} placeholder="搜索文件夹或文件名" /></div>
        {error && <div className="article-error">{error}</div>}
        {!query.trim() ? (
          <div className="article-directory-nav">
            <Button variant="ghost" size="icon-sm" disabled={!directory} onClick={() => setDirectory(directoryParts.slice(0, -1).join('/'))} aria-label="返回上一级" title="返回上一级"><ArrowLeft /></Button>
            <div className="article-breadcrumb"><button type="button" onClick={() => setDirectory('')}>全部文章</button>{directoryParts.map((part, index) => <span key={`${part}-${index}`}><ChevronRight /><button type="button" onClick={() => setDirectory(directoryParts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</div>
          </div>
        ) : <div className="article-search-result">“{query.trim()}”的搜索结果</div>}
        <nav className="article-list" aria-label="文章逻辑目录">
          {loading ? <div className="article-list-empty"><LoaderCircle className="spin" />正在读取文章…</div> : null}
          {currentLevel.folders.map((folder) => (
            <button className="article-folder-item" type="button" key={folder.path} onClick={() => { setDirectory(folder.path); if (query.trim()) setQuery(''); }}>
              <span><Folder /></span><strong>{folder.name}</strong><small>{folder.count}</small><ChevronRight />
            </button>
          ))}
          {currentLevel.articles.map((article) => (
            <button className={`article-item ${currentKey === article.key ? 'is-active' : ''}`} type="button" key={article.key} onClick={() => void openArticle(article.sourceId, article.path)} title={`${article.sourceName} · ${article.path}`}>
              <span className="article-item-icon"><FileText /></span>
              <span><strong>{article.title}</strong><small>{article.excerpt || '暂无摘要'}</small><em>{article.sourceName} · {articleFileName(logicalPath(article))}</em></span>
            </button>
          ))}
          {!loading && !currentLevel.folders.length && !currentLevel.articles.length ? <div className="article-list-empty">{query.trim() ? '没有找到 Markdown 文章' : '当前层级没有文章'}</div> : null}
        </nav>
      </aside>

      <article className="article-reader">
        <div className="article-reader-scroll" ref={articleReader}>
          {current ? (
            <div className="article-document">
              <p className="article-path">{current.sourceName} · {current.path}</p>
              <h1>{current.title}</h1>
              <StaticMarkdown className="markdown-body article-markdown" html={current.html} />
            </div>
          ) : <div className="article-reader-empty"><BookOpenText /><p>选择一篇文章开始阅读和审核</p></div>}
        </div>
        {current ? (
          <footer className="article-status-bar">
            <span title={`${current.sourceName} · ${current.path}`}>{current.characters.toLocaleString('zh-CN')} 字符 · 更新于 {dateTime(current.updatedAt)}</span>
            <span className={`article-sync is-${sync.status}`} title={sync.error || undefined}>{syncLabel}</span>
            <span>最终检查：{dateTime(review.finalCheckedAt)}</span>
            <Button variant="ghost" size="icon-sm" disabled={sync.status === 'checking'} onClick={() => void reloadCurrent()} aria-label="立即刷新文章" title="立即刷新文章"><RefreshCw className={sync.status === 'checking' ? 'spin' : ''} /></Button>
          </footer>
        ) : null}
      </article>

      <aside className="article-chat">
        <section className="article-review-panel">
          <header><div><ShieldCheck /><span><strong>AI 审核清单</strong><small>点击后由 AI 检查并直接修正文档</small></span></div><Button size="sm" disabled={!current || chatBusy} onClick={() => runReview('final')}><ShieldCheck />最终检查</Button></header>
          <div className="article-review-items">
            {REVIEW_ITEMS.map((item) => {
              const status = review.items[item.id] || 'idle';
              return <button type="button" key={item.id} className={`is-${status}`} disabled={!current || chatBusy} onClick={() => runReview(item.id)}>{status === 'running' ? <LoaderCircle className="spin" /> : status === 'checked' ? <Check /> : <Circle />}<span>{item.label}</span></button>;
            })}
          </div>
        </section>
        <ChatWorkspace
          compact
          enabled={Boolean(current)}
          scope="article"
          sourceId={current?.sourceId}
          articlePath={current?.path}
          title={current?.title || '文章审核'}
          subtitle="独立永久上下文"
          promptRequest={promptRequest}
          onRunComplete={handleRunComplete}
          onBusyChange={setChatBusy}
          onArticleChanged={() => void reloadCurrent()}
          onUnauthorized={onUnauthorized}
        />
      </aside>
    </section>
  );
}
