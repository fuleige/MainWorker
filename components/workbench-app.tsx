'use client';

import { SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid, MessageSquareText, PanelLeftClose, PanelLeftOpen, Settings2, ShieldCheck } from 'lucide-react';
import { ArticlesModule } from '@/components/articles-module';
import { ChatWorkspace } from '@/components/chat-workspace';
import { PlannerModule } from '@/components/planner-module';
import { SettingsModule, SettingsSection } from '@/components/settings-module';
import { ToolWorkbench } from '@/components/tool-workbench';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type ViewId = 'chat' | 'workbench' | 'articles' | 'planner' | 'settings';
type AppRoute = { view: ViewId; sessionId: number | null; settingsSection: SettingsSection };

const LAST_CHAT_HREF_KEY = 'mainworker:last-chat-href';

const primaryModules = [
  { id: 'chat' as const, label: '对话', icon: MessageSquareText },
  { id: 'workbench' as const, label: '工作台', icon: LayoutGrid },
];

function canonicalUrl() {
  const current = new URL(location.href);
  if (current.pathname !== '/') return `${current.pathname}${current.search}${current.hash}`;
  const legacyModule = current.searchParams.get('module');
  if (legacyModule === 'articles') {
    current.searchParams.delete('module');
    const query = current.searchParams.toString();
    return `/tools/articles${query ? `?${query}` : ''}${current.hash}`;
  }
  if (legacyModule === 'planner') return '/tools/planner';
  if (legacyModule === 'limits') return '/settings/usage';
  const legacySession = Number(current.searchParams.get('session'));
  return Number.isSafeInteger(legacySession) && legacySession > 0 ? `/chat/${legacySession}` : '/chat';
}

function readRoute(): AppRoute {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const chatMatch = path.match(/^\/chat(?:\/(\d+))?$/);
  if (chatMatch) {
    const sessionId = chatMatch[1] ? Number(chatMatch[1]) : null;
    return { view: 'chat', sessionId, settingsSection: 'chat' };
  }
  if (path === '/workbench') return { view: 'workbench', sessionId: null, settingsSection: 'chat' };
  if (path === '/tools/articles') return { view: 'articles', sessionId: null, settingsSection: 'chat' };
  if (path === '/tools/planner') return { view: 'planner', sessionId: null, settingsSection: 'chat' };
  const settingsMatch = path.match(/^\/settings(?:\/(chat|models|usage|security))?$/);
  if (settingsMatch) return { view: 'settings', sessionId: null, settingsSection: (settingsMatch[1] || 'chat') as SettingsSection };
  return { view: 'chat', sessionId: null, settingsSection: 'chat' };
}

function hrefForView(view: 'chat' | 'workbench' | 'settings') {
  if (view === 'workbench') return '/workbench';
  if (view === 'settings') return '/settings/chat';
  return '/chat';
}

function normalizedChatHref(value: string | null) {
  if (!value) return null;
  const path = value.replace(/\/+$/, '') || '/';
  return /^\/chat(?:\/[1-9]\d*)?$/.test(path) ? path : null;
}

function currentChatHref() {
  return normalizedChatHref(location.pathname);
}

function storedChatHref() {
  try {
    return normalizedChatHref(sessionStorage.getItem(LAST_CHAT_HREF_KEY));
  } catch {
    return null;
  }
}

function storeChatHref(href: string) {
  try {
    sessionStorage.setItem(LAST_CHAT_HREF_KEY, href);
  } catch {
    // The URL and in-memory value still preserve navigation when storage is unavailable.
  }
}

export function WorkbenchApp() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [route, setRoute] = useState<AppRoute>({ view: 'chat', sessionId: null, settingsSection: 'chat' });
  const [railCollapsed, setRailCollapsed] = useState(false);
  const lastChatHref = useRef('/chat');
  const requireLogin = useCallback(() => setAuthenticated(false), []);
  const rememberChatHref = useCallback((href: string) => {
    const normalized = normalizedChatHref(href) || '/chat';
    lastChatHref.current = normalized;
    storeChatHref(normalized);
  }, []);

  useEffect(() => {
    const canonical = canonicalUrl();
    if (`${location.pathname}${location.search}${location.hash}` !== canonical) history.replaceState(null, '', canonical);
    const initialChatHref = currentChatHref();
    if (initialChatHref) rememberChatHref(initialChatHref);
    else lastChatHref.current = storedChatHref() || '/chat';
    queueMicrotask(() => {
      setRoute(readRoute());
      setRailCollapsed(localStorage.getItem('mainworker:rail-collapsed') === '1');
    });
    const onPopState = () => {
      const chatHref = currentChatHref();
      if (chatHref) rememberChatHref(chatHref);
      setRoute(readRoute());
    };
    addEventListener('popstate', onPopState);
    fetch('/api/session/status')
      .then((response) => response.json() as Promise<{ authenticated?: boolean }>)
      .then((payload) => setAuthenticated(Boolean(payload.authenticated)))
      .catch(() => setAuthenticated(false));
    return () => removeEventListener('popstate', onPopState);
  }, [rememberChatHref]);

  useEffect(() => {
    if (route.view === 'chat') return;
    const titles: Record<Exclude<ViewId, 'chat'>, string> = {
      workbench: '工作台 · MainWorker',
      articles: '文章审核 · MainWorker',
      planner: '个人规划 · MainWorker',
      settings: '设置 · MainWorker',
    };
    document.title = titles[route.view];
  }, [route.view]);

  function navigate(href: string, mode: 'push' | 'replace' = 'push') {
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (current === href) return;
    const chatHref = currentChatHref();
    if (chatHref) rememberChatHref(chatHref);
    history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', href);
    const nextChatHref = currentChatHref();
    if (nextChatHref) rememberChatHref(nextChatHref);
    setRoute(readRoute());
  }

  function changeView(view: 'chat' | 'workbench' | 'settings') {
    navigate(view === 'chat' ? lastChatHref.current : hrefForView(view));
  }

  function changeSessionUrl(sessionId: number | null, mode: 'push' | 'replace') {
    const href = sessionId ? `/chat/${sessionId}` : '/chat';
    const current = `${location.pathname}${location.search}`;
    rememberChatHref(href);
    if (current === href) return;
    history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', href);
  }

  function toggleRail() {
    setRailCollapsed((current) => {
      const next = !current;
      localStorage.setItem('mainworker:rail-collapsed', next ? '1' : '0');
      return next;
    });
  }

  async function login(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError('');
    setLoginBusy(true);
    try {
      const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        setLoginError(response.status >= 500 ? '工作台后端未启动或正在重启，请查看终端输出' : payload.error || '访问口令错误');
        return;
      }
      setToken('');
      setAuthenticated(true);
    } catch {
      setLoginError('无法连接工作台服务，请确认服务仍在运行');
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/session', { method: 'DELETE' });
    setAuthenticated(false);
  }

  const primaryView = route.view === 'articles' || route.view === 'planner' ? 'workbench' : route.view;

  if (authenticated === null) return <main className="boot-screen"><span className="brand-mark">M</span><p>正在打开 MainWorker…</p></main>;

  return (
    <main className={`workbench-shell ${railCollapsed ? 'is-rail-collapsed' : ''}`}>
      <aside className={`app-rail ${railCollapsed ? 'is-collapsed' : ''}`} aria-label="主导航">
        {railCollapsed ? (
          <Button className="rail-button rail-expand" variant="ghost" size="icon-sm" aria-label="展开工具栏" title="展开工具栏" onClick={toggleRail}><PanelLeftOpen /></Button>
        ) : (
          <>
            <div className="brand-mark" aria-label="MainWorker">M</div>
            <nav className="rail-nav">{primaryModules.map((item) => <Button key={item.id} className={`rail-button ${primaryView === item.id ? 'is-active' : ''}`} variant="ghost" size="icon-lg" aria-label={item.label} title={item.label} onClick={() => changeView(item.id)}><item.icon /></Button>)}</nav>
            <div className="rail-footer">
              <Button className="rail-button" variant="ghost" size="icon-lg" aria-label="折叠工具栏" title="折叠工具栏" onClick={toggleRail}><PanelLeftClose /></Button>
              <Button className={`rail-button ${route.view === 'settings' ? 'is-active' : ''}`} variant="ghost" size="icon-lg" aria-label="设置" title="设置" onClick={() => changeView('settings')}><Settings2 /></Button>
            </div>
          </>
        )}
      </aside>

      <div className="module-stage">
        {authenticated && route.view === 'chat' ? <ChatWorkspace scope="workspace" title="MainWorker" subtitle="永久会话 · 当前工作目录" sessionId={route.sessionId} onSessionUrlChange={changeSessionUrl} onUnauthorized={requireLogin} /> : null}
        {authenticated && route.view === 'workbench' ? <ToolWorkbench /> : null}
        {authenticated && route.view === 'articles' ? <ArticlesModule onUnauthorized={requireLogin} /> : null}
        {authenticated && route.view === 'planner' ? <PlannerModule onUnauthorized={requireLogin} /> : null}
        {authenticated && route.view === 'settings' ? <SettingsModule section={route.settingsSection} onNavigate={(section) => navigate(`/settings/${section}`)} onUnauthorized={requireLogin} onLogout={() => void logout()} /> : null}
      </div>

      <nav className="mobile-tabs" aria-label="移动端导航">
        <button className={primaryView === 'chat' ? 'is-active' : ''} onClick={() => changeView('chat')}><MessageSquareText /><span>对话</span></button>
        <button className={primaryView === 'workbench' ? 'is-active' : ''} onClick={() => changeView('workbench')}><LayoutGrid /><span>工作台</span></button>
        <button className={primaryView === 'settings' ? 'is-active' : ''} onClick={() => changeView('settings')}><Settings2 /><span>设置</span></button>
      </nav>

      <Dialog open={!authenticated} onOpenChange={() => {}}>
        <DialogContent showCloseButton={false} className="login-dialog">
          <div className="login-mark">M</div>
          <DialogHeader><p className="overline">PRIVATE WORKBENCH</p><DialogTitle>进入 MainWorker</DialogTitle><DialogDescription>输入本机生成的访问口令。登录后会继续打开当前地址。</DialogDescription></DialogHeader>
          <form onSubmit={login} className="login-form"><label htmlFor="access-token"><span>访问口令</span></label><Input id="access-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} disabled={loginBusy} />{loginError && <p className="login-error">{loginError}</p>}<Button type="submit" size="lg" disabled={!token || loginBusy}>{loginBusy ? '正在验证…' : '进入工作台'}</Button></form>
          <p className="login-hint"><ShieldCheck />在项目目录运行 <code>npm run token</code> 查看口令</p>
        </DialogContent>
      </Dialog>
    </main>
  );
}
