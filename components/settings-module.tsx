'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Database, Gauge, LoaderCircle, LogOut, PackageCheck, RefreshCw, Save, ShieldCheck, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import packageMetadata from '@/package.json';
import { ChatModel } from '@/hooks/use-chat';
import { IOS_CHROME_LAST_RELOAD_AT_KEY, IOS_CHROME_RELOAD_COUNT_KEY } from '@/hooks/use-ios-chrome-restoration-reload';
import { LimitsModule } from '@/components/limits-module';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { api } from '@/lib/workbench-api';

export type SettingsSection = 'chat' | 'models' | 'usage' | 'security';
type ModeDefault = { model: string; reasoningEffort: string };
type ChatDefaults = { work: ModeDefault; quick: ModeDefault };
type RefreshMetadata = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  cacheExpiresAt: string | null;
  nextScheduledAt: string | null;
  refreshAllowedAt: string | null;
  status: 'fresh' | 'stale' | 'error' | 'empty';
  source: string;
  error: string | null;
  policy: { cacheTtlMs: number; polling: boolean };
};
type SettingsPayload = {
  models: ChatModel[];
  modeDefaults: ChatDefaults;
  codexDefaults: ModeDefault;
  refresh: RefreshMetadata;
};

const sections = [
  { id: 'usage' as const, label: '用量与额度', icon: Gauge },
  { id: 'chat' as const, label: '对话默认值', icon: SlidersHorizontal },
  { id: 'models' as const, label: '模型与 Codex', icon: Database },
  { id: 'security' as const, label: '安全', icon: ShieldCheck },
];

const effortLabels: Record<string, string> = {
  low: '低 Low', medium: '中 Medium', high: '高 High', xhigh: '极高 XHigh', max: '最大 Max', ultra: '极限 Ultra',
};

function dateTime(value: string | null, withSeconds = false) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(date);
}

function effortForModel(models: ChatModel[], modelId: string, preferred = '') {
  const model = models.find((item) => item.id === modelId);
  if (!model) return '';
  return model.reasoningEfforts.some((effort) => effort.id === preferred)
    ? preferred
    : model.defaultReasoningEffort || model.reasoningEfforts[0]?.id || '';
}

function DefaultEditor({ label, description, models, value, onChange }: {
  label: string;
  description: string;
  models: ChatModel[];
  value: ModeDefault;
  onChange: (value: ModeDefault) => void;
}) {
  const selected = models.find((model) => model.id === value.model) || models[0];
  return (
    <article className="settings-default-card">
      <div className="settings-default-heading"><span><Bot /></span><div><h3>{label}</h3><p>{description}</p></div></div>
      <label><span>默认模型</span><NativeSelect value={value.model} onChange={(event) => onChange({ model: event.target.value, reasoningEffort: effortForModel(models, event.target.value, value.reasoningEffort) })}>{models.map((model) => <NativeSelectOption key={model.id} value={model.id}>{model.name}</NativeSelectOption>)}</NativeSelect></label>
      <label><span>默认思考度</span><NativeSelect value={value.reasoningEffort} onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value })}>{selected?.reasoningEfforts.map((effort) => <NativeSelectOption key={effort.id} value={effort.id}>{effortLabels[effort.id] || effort.id}</NativeSelectOption>)}</NativeSelect></label>
    </article>
  );
}

export function SettingsModule({ section, onNavigate, onUnauthorized, onLogout }: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onUnauthorized: () => void;
  onLogout: () => void;
}) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [chatDefaults, setChatDefaults] = useState<ChatDefaults | null>(null);
  const [codexDefaults, setCodexDefaults] = useState<ModeDefault | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<'chat' | 'codex' | 'refresh' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [iosChromeReload, setIOSChromeReload] = useState<{ count: number; lastAt: string | null }>({ count: 0, lastAt: null });
  const settingsLoadStarted = useRef(false);
  const settingsLoadInFlight = useRef(false);

  const applyPayload = useCallback((next: SettingsPayload) => {
    setPayload(next);
    setChatDefaults(next.modeDefaults);
    setCodexDefaults(next.codexDefaults);
  }, []);

  const load = useCallback(async () => {
    if (settingsLoadInFlight.current) return;
    settingsLoadStarted.current = true;
    settingsLoadInFlight.current = true;
    setLoading(true);
    setError('');
    try {
      applyPayload(await api<SettingsPayload>('/api/settings'));
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '设置读取失败');
    } finally {
      settingsLoadInFlight.current = false;
      setLoading(false);
    }
  }, [applyPayload, onUnauthorized]);

  useEffect(() => {
    if ((section === 'chat' || section === 'models') && !payload && !settingsLoadStarted.current) queueMicrotask(() => void load());
  }, [load, payload, section]);

  useEffect(() => {
    if (section !== 'security') return;
    let count = 0;
    let lastAt: string | null = null;
    try {
      count = Number(localStorage.getItem(IOS_CHROME_RELOAD_COUNT_KEY)) || 0;
      const timestamp = Number(localStorage.getItem(IOS_CHROME_LAST_RELOAD_AT_KEY));
      if (timestamp > 0) lastAt = new Date(timestamp).toISOString();
    } catch {
      // Recovery status is optional when storage is unavailable.
    }
    queueMicrotask(() => setIOSChromeReload({ count, lastAt }));
  }, [section]);

  async function saveChatDefaults() {
    if (!chatDefaults || saving) return;
    setSaving('chat');
    setError('');
    setMessage('');
    try {
      applyPayload(await api<SettingsPayload>('/api/settings/chat-defaults', { method: 'PATCH', body: JSON.stringify(chatDefaults) }));
      setMessage('对话默认值已保存，只会用于之后创建的新会话。');
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '默认值保存失败');
    } finally {
      setSaving(null);
    }
  }

  async function saveCodexDefaults() {
    if (!codexDefaults || saving) return;
    setSaving('codex');
    setError('');
    setMessage('');
    try {
      applyPayload(await api<SettingsPayload>('/api/settings/codex', { method: 'PATCH', body: JSON.stringify(codexDefaults) }));
      setMessage('Codex 全局默认值已更新。MainWorker 已有会话不会改变。');
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : 'Codex 全局配置保存失败');
    } finally {
      setSaving(null);
    }
  }

  async function refreshModels() {
    if (saving) return;
    setSaving('refresh');
    setError('');
    setMessage('');
    try {
      const next = await api<SettingsPayload>('/api/chat/models/refresh', { method: 'POST' });
      applyPayload(next);
      if (next.refresh.status === 'error') setError(`模型目录刷新失败，当前继续使用上次成功的数据：${next.refresh.error || '未知错误'}`);
      else setMessage('模型目录已手动刷新。');
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '模型目录刷新失败');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="settings-module">
      <aside className="settings-nav">
        <header><p className="overline">PREFERENCES</p><h1>设置</h1></header>
        <nav aria-label="设置分类">{sections.map((item) => <button type="button" key={item.id} className={section === item.id ? 'is-active' : ''} onClick={() => onNavigate(item.id)}><item.icon /><span>{item.label}</span></button>)}</nav>
      </aside>

      <div className="settings-content">
        {error ? <div className="settings-feedback is-error" role="alert">{error}</div> : null}
        {message ? <output className="settings-feedback is-success">{message}</output> : null}
        {error && !payload && !loading ? <div className="settings-retry"><Button variant="outline" onClick={() => void load()}><RefreshCw />重新加载设置</Button></div> : null}

        {section === 'chat' ? (
          <div className="settings-page">
            <header className="settings-page-header"><div><p className="overline">CHAT DEFAULTS</p><h2>对话默认值</h2><p>工作对话与快速问答分别保存默认模型和思考度。</p></div></header>
            {loading && !payload ? <div className="settings-loading"><LoaderCircle className="spin" />正在读取模型和默认值…</div> : null}
            {payload && chatDefaults ? (
              <>
                <div className="settings-default-grid">
                  <DefaultEditor label="工作对话" description="适合访问和修改当前工作目录。" models={payload.models} value={chatDefaults.work} onChange={(value) => setChatDefaults((current) => current ? { ...current, work: value } : current)} />
                  <DefaultEditor label="快速问答" description="独立默认值；初始思考度为 Medium。" models={payload.models} value={chatDefaults.quick} onChange={(value) => setChatDefaults((current) => current ? { ...current, quick: value } : current)} />
                </div>
                <div className="settings-important"><TriangleAlert /><div><strong>仅影响新会话</strong><p>已有会话继续使用创建时保存的模型和思考度，不会被批量修改。</p></div></div>
                <div className="settings-actions"><Button onClick={() => void saveChatDefaults()} disabled={Boolean(saving)}>{saving === 'chat' ? <LoaderCircle className="spin" /> : <Save />}保存对话默认值</Button></div>
              </>
            ) : null}
          </div>
        ) : null}

        {section === 'models' ? (
          <div className="settings-page">
            <header className="settings-page-header"><div><p className="overline">MODELS & CODEX</p><h2>模型与 Codex</h2><p>模型目录采用一小时惰性缓存；只有手动刷新或过期后的下一次使用才会重新读取。</p></div></header>
            {loading && !payload ? <div className="settings-loading"><LoaderCircle className="spin" />正在读取模型目录…</div> : null}
            {payload && codexDefaults ? (
              <>
                <article className="model-cache-card">
                  <div className="model-cache-heading"><div><Database /><span><strong>模型目录</strong><small>{payload.models.length} 个可用模型 · {payload.refresh.source}</small></span></div><Badge variant={payload.refresh.status === 'error' ? 'destructive' : 'secondary'}>{payload.refresh.status === 'fresh' ? '缓存有效' : payload.refresh.status === 'error' ? '刷新异常' : payload.refresh.status === 'stale' ? '缓存已过期' : '尚未读取'}</Badge></div>
                  <dl>
                    <div><dt>上次尝试</dt><dd>{dateTime(payload.refresh.lastAttemptAt, true)}</dd></div>
                    <div><dt>上次成功</dt><dd>{dateTime(payload.refresh.lastSuccessAt, true)}</dd></div>
                    <div><dt>缓存有效至</dt><dd>{dateTime(payload.refresh.cacheExpiresAt, true)}</dd></div>
                    <div><dt>自动刷新</dt><dd>{payload.refresh.policy.polling ? dateTime(payload.refresh.nextScheduledAt, true) : '不定时刷新'}</dd></div>
                  </dl>
                  {payload.refresh.error ? <p className="model-cache-error">最近一次刷新失败，当前继续显示上次成功的数据：{payload.refresh.error}</p> : null}
                  <Button variant="outline" onClick={() => void refreshModels()} disabled={Boolean(saving)}>{saving === 'refresh' ? <LoaderCircle className="spin" /> : <RefreshCw />}{saving === 'refresh' ? '正在刷新' : '手动刷新模型目录'}</Button>
                </article>

                <article className="codex-global-card">
                  <div className="settings-default-heading"><span><Bot /></span><div><h3>Codex 全局默认值</h3><p>写入本机 Codex 配置，可能同时影响 CLI、IDE、桌面端和其他 App Server 客户端。</p></div></div>
                  <div className="codex-global-fields">
                    <label><span>全局默认模型</span><NativeSelect value={codexDefaults.model} onChange={(event) => setCodexDefaults({ model: event.target.value, reasoningEffort: effortForModel(payload.models, event.target.value, codexDefaults.reasoningEffort) })}>{payload.models.map((model) => <NativeSelectOption key={model.id} value={model.id}>{model.name}</NativeSelectOption>)}</NativeSelect></label>
                    <label><span>全局默认思考度</span><NativeSelect value={codexDefaults.reasoningEffort} onChange={(event) => setCodexDefaults({ ...codexDefaults, reasoningEffort: event.target.value })}>{payload.models.find((model) => model.id === codexDefaults.model)?.reasoningEfforts.map((effort) => <NativeSelectOption key={effort.id} value={effort.id}>{effortLabels[effort.id] || effort.id}</NativeSelectOption>)}</NativeSelect></label>
                  </div>
                  <div className="settings-actions"><Button onClick={() => void saveCodexDefaults()} disabled={Boolean(saving)}>{saving === 'codex' ? <LoaderCircle className="spin" /> : <Save />}保存 Codex 全局默认值</Button></div>
                </article>
              </>
            ) : null}
          </div>
        ) : null}

        {section === 'usage' ? <LimitsModule onUnauthorized={onUnauthorized} /> : null}

        {section === 'security' ? (
          <div className="settings-page">
            <header className="settings-page-header"><div><p className="overline">SECURITY</p><h2>安全</h2><p>当前服务使用单用户 Token 鉴权，凭据只保留在运行 MainWorker 的电脑上。</p></div></header>
            <div className="settings-card"><ShieldCheck /><div><strong>访问已受保护</strong><p>登录状态保存在安全 Cookie 中；直接访问收藏的工具或会话地址时，登录后会留在原地址。</p></div></div>
            <div className="settings-card settings-version-card"><PackageCheck /><div><strong>版本信息</strong><p>MainWorker <Badge variant="secondary">v{packageMetadata.version}</Badge> · 可用于确认当前生产界面是否已经更新。</p><p>iOS Chrome 历史页恢复：{iosChromeReload.count > 0 ? `已重载 ${iosChromeReload.count} 次，最近 ${dateTime(iosChromeReload.lastAt, true)}` : '尚未触发'}</p></div></div>
            <div className="settings-actions"><Button variant="destructive" onClick={onLogout}><LogOut />退出登录</Button></div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
