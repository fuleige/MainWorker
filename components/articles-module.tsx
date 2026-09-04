'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpenText, FileText, LoaderCircle, MessageSquareText, Search } from 'lucide-react';
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

function decodeAnchor(value: string) {
  const encoded = value.replace(/^#/, '');
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function ArticlesModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [current, setCurrent] = useState<Article | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'article' | 'articles'>('article');
  const [mobilePane, setMobilePane] = useState<'library' | 'reader' | 'chat'>('reader');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const articleReader = useRef<HTMLElement>(null);
  const pendingReaderPosition = useRef<{ scrollTop: number; anchor: string } | null>(null);
  const refreshInFlight = useRef(false);
  const currentKey = current?.key || null;

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
        params.set('module', 'articles');
        params.set('source', payload.sourceId);
        params.set('article', payload.path);
        history.replaceState(null, '', `/?${params}${normalizedAnchor ? `#${encodeURIComponent(normalizedAnchor)}` : ''}`);
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
    let cancelled = false;
    const interval = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !current || refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        const status = await api<{ updatedAt: string }>(`/api/article/status?source=${encodeURIComponent(current.sourceId)}&path=${encodeURIComponent(current.path)}`);
        if (!cancelled && status.updatedAt !== current.updatedAt) await openArticle(current.sourceId, current.path, false);
      } catch (error) {
        if ((error as { status?: number }).status === 401) onUnauthorized();
      } finally {
        refreshInFlight.current = false;
      }
    }, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [current, onUnauthorized, openArticle]);

  const navigateArticleLink = useCallback((event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target || link.getAttribute('href')?.startsWith('#')) return;
    const url = new URL(link.href, location.href);
    const articlePath = url.searchParams.get('article');
    if (url.origin !== location.origin || url.searchParams.get('module') !== 'articles' || !articlePath) return;
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

  return (
    <section className={`articles-module mobile-pane-${mobilePane}`}>
      <nav className="article-mobile-nav" aria-label="文章工作区">
        <Button variant={mobilePane === 'library' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('library')}><BookOpenText />目录</Button>
        <Button variant={mobilePane === 'reader' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('reader')}><FileText />正文</Button>
        <Button variant={mobilePane === 'chat' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('chat')}><MessageSquareText />审核</Button>
      </nav>
      <aside className="article-library">
        <header className="article-library-header"><div><p className="overline">KNOWLEDGE</p><h1>文章审核</h1></div><span>{articles.length}</span></header>
        <div className="article-search"><Search /><Input aria-label="搜索标题或正文" value={query} onChange={(event) => search(event.target.value)} placeholder="搜索标题或正文" /></div>
        {error && <div className="article-error">{error}</div>}
        <nav className="article-list" aria-label="文章列表">
          {loading ? <div className="article-list-empty"><LoaderCircle className="spin" />正在读取文章…</div> : null}
          {articles.map((article) => (
            <button className={`article-item ${current?.key === article.key ? 'is-active' : ''}`} type="button" key={article.key} onClick={() => void openArticle(article.sourceId, article.path)}>
              <span className="article-item-icon"><FileText /></span>
              <span><strong>{article.title}</strong><small>{article.excerpt || article.path}</small><em>{article.sourceName} · {article.path}</em></span>
            </button>
          ))}
          {!loading && !articles.length ? <div className="article-list-empty">没有找到 Markdown 文章</div> : null}
        </nav>
      </aside>

      <article className="article-reader" ref={articleReader}>
        <header className="article-reader-bar">
          {current && <span>{current.characters.toLocaleString('zh-CN')} 字符 · {new Date(current.updatedAt).toLocaleDateString('zh-CN')}</span>}
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
        <div className="article-scope-tabs">
          <button className={scope === 'article' ? 'is-active' : ''} onClick={() => setScope('article')} disabled={!current}>当前文章</button>
          <button className={scope === 'articles' ? 'is-active' : ''} onClick={() => setScope('articles')}>整个项目</button>
        </div>
        <ChatWorkspace
          compact
          enabled={scope === 'articles' || Boolean(current)}
          scope={scope}
          sourceId={current?.sourceId}
          articlePath={scope === 'article' ? current?.path : null}
          title={scope === 'article' ? current?.title || '文章审核' : '文章项目对话'}
          subtitle={scope === 'article' ? '独立永久上下文' : '跨文章永久上下文'}
          onUnauthorized={onUnauthorized}
        />
      </aside>
    </section>
  );
}
