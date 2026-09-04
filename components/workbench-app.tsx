'use client';

import { SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { BookOpenText, CalendarDays, Gauge, LogOut, MessageSquareText, PanelLeftClose, PanelLeftOpen, Settings2, ShieldCheck } from 'lucide-react';
import { ArticlesModule } from '@/components/articles-module';
import { ChatWorkspace } from '@/components/chat-workspace';
import { LimitsModule } from '@/components/limits-module';
import { PlannerModule } from '@/components/planner-module';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type ModuleId = 'chat' | 'articles' | 'planner' | 'limits';

const modules = [
  { id: 'chat' as const, label: '对话', icon: MessageSquareText },
  { id: 'articles' as const, label: '文章', icon: BookOpenText },
  { id: 'planner' as const, label: '规划', icon: CalendarDays },
  { id: 'limits' as const, label: '额度', icon: Gauge },
];

export function WorkbenchApp() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [module, setModule] = useState<ModuleId>('chat');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const requireLogin = useCallback(() => setAuthenticated(false), []);

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('module');
    queueMicrotask(() => setRailCollapsed(localStorage.getItem('mainworker:rail-collapsed') === '1'));
    const initialModule = requested === 'articles' || requested === 'planner' || requested === 'chat' || requested === 'limits'
      ? requested
      : 'chat';
    queueMicrotask(() => setModule(initialModule));
    fetch('/api/session/status')
      .then((response) => response.json() as Promise<{ authenticated?: boolean }>)
      .then((payload) => setAuthenticated(Boolean(payload.authenticated)))
      .catch(() => setAuthenticated(false));
  }, []);

  function changeModule(next: ModuleId) {
    setModule(next);
    const params = new URLSearchParams(location.search);
    params.set('module', next);
    if (next !== 'articles') {
      params.delete('article');
      params.delete('source');
    }
    history.replaceState(null, '', `/?${params}`);
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
    setSettingsOpen(false);
    setAuthenticated(false);
  }

  if (authenticated === null) return <main className="boot-screen"><span className="brand-mark">M</span><p>正在打开 MainWorker…</p></main>;

  return (
    <main className={`workbench-shell ${railCollapsed ? 'is-rail-collapsed' : ''}`}>
      <aside className={`app-rail ${railCollapsed ? 'is-collapsed' : ''}`} aria-label="工作台导航">
        {railCollapsed ? (
          <Button className="rail-button rail-expand" variant="ghost" size="icon-sm" aria-label="展开工具栏" title="展开工具栏" onClick={toggleRail}><PanelLeftOpen /></Button>
        ) : (
          <>
            <div className="brand-mark" aria-label="MainWorker">M</div>
            <nav className="rail-nav">{modules.map((item) => <Button key={item.id} className={`rail-button ${module === item.id ? 'is-active' : ''}`} variant="ghost" size="icon-lg" aria-label={item.label} title={item.label} onClick={() => changeModule(item.id)}><item.icon /></Button>)}</nav>
            <div className="rail-footer">
              <Button className="rail-button" variant="ghost" size="icon-lg" aria-label="折叠工具栏" title="折叠工具栏" onClick={toggleRail}><PanelLeftClose /></Button>
              <Button className="rail-button" variant="ghost" size="icon-lg" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Settings2 /></Button>
            </div>
          </>
        )}
      </aside>

      <div className="module-stage">
        {authenticated && module === 'chat' ? <ChatWorkspace scope="workspace" title="MainWorker" subtitle="永久会话 · 当前工作目录" onUnauthorized={requireLogin} /> : null}
        {authenticated && module === 'articles' ? <ArticlesModule onUnauthorized={requireLogin} /> : null}
        {authenticated && module === 'planner' ? <PlannerModule onUnauthorized={requireLogin} /> : null}
        {authenticated && module === 'limits' ? <LimitsModule onUnauthorized={requireLogin} /> : null}
      </div>

      <nav className="mobile-tabs" aria-label="移动端导航">{modules.map((item) => <button key={item.id} className={module === item.id ? 'is-active' : ''} onClick={() => changeModule(item.id)}><item.icon /><span>{item.label}</span></button>)}</nav>

      <Dialog open={!authenticated} onOpenChange={() => {}}>
        <DialogContent showCloseButton={false} className="login-dialog">
          <div className="login-mark">M</div>
          <DialogHeader><p className="overline">PRIVATE WORKBENCH</p><DialogTitle>进入 MainWorker</DialogTitle><DialogDescription>输入本机生成的访问口令。登录状态会安全地保存在浏览器 Cookie 中。</DialogDescription></DialogHeader>
          <form onSubmit={login} className="login-form"><label htmlFor="access-token"><span>访问口令</span></label><Input id="access-token" type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} disabled={loginBusy} />{loginError && <p className="login-error">{loginError}</p>}<Button type="submit" size="lg" disabled={!token || loginBusy}>{loginBusy ? '正在验证…' : '进入工作台'}</Button></form>
          <p className="login-hint"><ShieldCheck />在项目目录运行 <code>npm run token</code> 查看口令</p>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent><DialogHeader><DialogTitle>工作台设置</DialogTitle><DialogDescription>当前为单用户 Token 鉴权模式。</DialogDescription></DialogHeader><div className="settings-card"><ShieldCheck /><div><strong>访问已受保护</strong><p>Codex 凭据只保留在运行工作台的电脑上。</p></div></div><Button variant="destructive" onClick={() => void logout()}><LogOut />退出登录</Button></DialogContent>
      </Dialog>
    </main>
  );
}
