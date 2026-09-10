'use client';

import { useEffect, useState } from 'react';
import { Clock3, Gauge, LoaderCircle, RefreshCw, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/workbench-api';

type LimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type AccountLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  primary: LimitWindow | null;
  secondary: LimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  individualLimit: { limit: string; used: string; remainingPercent: number; resetsAt: number } | null;
  spendControlReached: boolean | null;
  reachedType: string | null;
};

type ResetCredit = {
  id: string;
  title: string | null;
  description: string | null;
  expiresAt: number | null;
};

type LimitsPayload = {
  limits: AccountLimit[];
  resetCreditsCount: number | null;
  resetCredits: ResetCredit[] | null;
  fetchedAt: string;
  nextRefreshAt: string;
  refreshAllowedAt: string;
  cached: boolean;
  stale: boolean;
  refreshError: string | null;
  policy: { cacheTtlMs: number; manualCooldownMs: number; polling: boolean };
};

let clientCache: LimitsPayload | null = null;
let clientRead: Promise<LimitsPayload> | null = null;
const LIMITS_STORAGE_KEY = 'mainworker:account-limits';

function readStoredLimits() {
  if (typeof window === 'undefined') return null;
  try {
    const payload = JSON.parse(window.localStorage.getItem(LIMITS_STORAGE_KEY) || 'null') as Partial<LimitsPayload> | null;
    if (!payload || !Array.isArray(payload.limits) || typeof payload.fetchedAt !== 'string'
      || typeof payload.nextRefreshAt !== 'string' || typeof payload.refreshAllowedAt !== 'string'
      || !payload.policy || typeof payload.policy.cacheTtlMs !== 'number') return null;
    return payload as LimitsPayload;
  } catch {
    return null;
  }
}

function writeStoredLimits(payload: LimitsPayload) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIMITS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable in private browsing; the in-memory cache still works.
  }
}

function isClientCacheFresh(payload: LimitsPayload) {
  const hasResetCreditDetails = Object.prototype.hasOwnProperty.call(payload, 'resetCredits');
  return hasResetCreditDetails && Date.now() < new Date(payload.nextRefreshAt).getTime();
}

function readLimits(force = false) {
  if (!force && clientCache && isClientCacheFresh(clientCache)) return Promise.resolve(clientCache);
  if (clientRead) return clientRead;
  clientRead = api<LimitsPayload>(force ? '/api/account/limits/refresh' : '/api/account/limits', force ? { method: 'POST' } : {})
    .then((payload) => {
      clientCache = payload;
      writeStoredLimits(payload);
      return payload;
    })
    .finally(() => {
      clientRead = null;
    });
  return clientRead;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function limitDisplayOrder(limit: AccountLimit) {
  const id = limit.id.toLowerCase();
  const name = (limit.name || '').toLowerCase();
  const identity = `${id} ${name}`;
  if (id === 'codex' || name === 'codex') return 0;
  if (identity.includes('spark')) return 1;
  return 2;
}

function compareLimits(left: AccountLimit, right: AccountLimit) {
  return limitDisplayOrder(left) - limitDisplayOrder(right);
}

function quotaWindowLabel(minutes: number | null, fallback: string) {
  if (!minutes) return fallback;
  if (minutes === 7 * 1440) return '周额度';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

function dateTime(value: string | number | null) {
  if (!value) return '未知';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function expiryDateTime(value: number | null) {
  if (value == null) return '到期时间未知';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '到期时间未知';
  return `${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)} 到期`;
}

function expiryDateTimeAttribute(value: number | null) {
  if (value == null) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function untilReset(timestamp: number | null) {
  if (!timestamp) return { label: '重置时间未知', days: null };
  const remainingMs = Math.max(0, timestamp * 1000 - Date.now());
  if (remainingMs <= 0) return { label: '等待额度状态更新', days: null };
  if (remainingMs >= 86_400_000) {
    return { label: '', days: (remainingMs / 86_400_000).toFixed(1) };
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes >= 60) return { label: `约 ${Math.ceil(minutes / 60)} 小时后重置`, days: null };
  return { label: `约 ${minutes} 分钟后重置`, days: null };
}

function WindowUsage({ fallbackTitle, window }: { fallbackTitle: string; window: LimitWindow }) {
  const used = clampPercent(window.usedPercent);
  const available = clampPercent(100 - used);
  const tone = available <= 10 ? 'critical' : available <= 30 ? 'warning' : 'normal';
  const title = quotaWindowLabel(window.windowDurationMins, fallbackTitle);
  const resetCountdown = untilReset(window.resetsAt);
  return (
    <div className={`limit-window ${tone}`}>
      <div className="limit-window-heading">
        <div><span>{title}</span><strong>{available}% 可用</strong></div>
      </div>
      <progress className="sr-only" max={100} value={available} aria-label={`${title}可用额度 ${available}%`} />
      <div className="limit-progress" aria-hidden="true">
        <span className="limit-progress-fill" style={{ width: `${available}%` }} />
      </div>
      <div className="limit-reset"><Clock3 /><span>{resetCountdown.days ? <>约 <strong className="limit-reset-days">{resetCountdown.days} 天</strong>后重置</> : resetCountdown.label} · {dateTime(window.resetsAt)}</span></div>
    </div>
  );
}

export function LimitsModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [payload, setPayload] = useState<LimitsPayload | null>(clientCache);
  const [loading, setLoading] = useState(() => !clientCache || !isClientCacheFresh(clientCache));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (clientCache) return;
    const stored = readStoredLimits();
    if (!stored) return;
    let active = true;
    clientCache = stored;
    queueMicrotask(() => {
      if (!active) return;
      setPayload(stored);
      setNow(Date.now());
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    readLimits().then((result) => {
      if (!active) return;
      setPayload(result);
      setError('');
    }).catch((caught) => {
      if (!active) return;
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '额度读取失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [onUnauthorized]);

  useEffect(() => {
    if (!payload) return;
    const allowedAt = new Date(payload.refreshAllowedAt).getTime();
    const expiresAt = new Date(payload.nextRefreshAt).getTime();
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (allowedAt > Date.now()) {
      interval = setInterval(() => {
        const current = Date.now();
        setNow(current);
        if (current >= allowedAt && interval) clearInterval(interval);
      }, 1000);
    }
    if (expiresAt > Date.now()) timeout = setTimeout(() => setNow(Date.now()), expiresAt - Date.now() + 50);
    return () => {
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, [payload]);

  const refreshWaitMs = payload ? Math.max(0, new Date(payload.refreshAllowedAt).getTime() - now) : 0;
  const cacheExpired = payload ? now >= new Date(payload.nextRefreshAt).getTime() : false;
  const showingStaleWhileRefreshing = Boolean(payload && loading && (cacheExpired || payload.stale));
  const orderedLimits = payload ? [...payload.limits].sort(compareLimits) : [];
  const resetCredits = payload?.resetCredits ?? null;
  const missingResetCreditDetails = payload?.resetCreditsCount == null
    ? 0
    : Math.max(0, payload.resetCreditsCount - (resetCredits?.length ?? 0));

  async function refresh() {
    if (refreshing || refreshWaitMs > 0) return;
    setRefreshing(true);
    setError('');
    try {
      const result = await readLimits(true);
      setPayload(result);
      setNow(Date.now());
    } catch (caught) {
      if ((caught as { status?: number }).status === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : '额度刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="limits-module">
      <header className="limits-header">
        <div><p className="overline">CODEX USAGE</p><h1>额度概览</h1><p>查看 Codex 当前额度窗口；页面不会自动轮询。</p></div>
        <Button variant="outline" aria-label="刷新额度" title="刷新额度" onClick={() => void refresh()} disabled={loading || refreshing || refreshWaitMs > 0}>
          {loading || refreshing ? <LoaderCircle className="spin" /> : <RefreshCw />}
          <span>{loading || refreshing ? '正在刷新' : refreshWaitMs > 0 ? `${Math.ceil(refreshWaitMs / 1000)} 秒后可刷新` : '手动刷新'}</span>
        </Button>
      </header>

      {error && <div className="limits-error" role="alert">{error}</div>}
      {payload?.refreshError && <output className="limits-warning">刷新失败，正在显示上一次的缓存数据：{payload.refreshError}</output>}
      {showingStaleWhileRefreshing ? (
        <output className="limits-refreshing" aria-live="polite">
          <LoaderCircle className="spin" />
          <span><strong>正在刷新额度</strong>当前先显示上一次读取的数据，刷新完成后会自动替换。</span>
        </output>
      ) : null}

      {loading && !payload ? <div className="limits-empty"><LoaderCircle className="spin" /><p>正在读取额度信息…</p></div> : null}
      {!loading && !payload ? <div className="limits-empty"><Gauge /><h2>暂时无法读取额度</h2><p>请确认 Codex 已登录，然后再试一次。</p></div> : null}

      {payload ? (
        <>
          <div className="limits-summary">
            <div><span className="limits-summary-icon warm"><Clock3 /></span><p>上次更新<strong>{dateTime(payload.fetchedAt)}</strong></p></div>
            <div><span className="limits-summary-icon green"><RefreshCw /></span><p>缓存有效至<strong>{cacheExpired ? '已过期，等待下次使用刷新' : dateTime(payload.nextRefreshAt)}</strong></p></div>
            {payload.resetCreditsCount != null ? (
              <div className="reset-credit-summary" title="当前账户可用于恢复 Codex 额度窗口的重置权益">
                <span className="limits-summary-icon credit"><RefreshCw /></span>
                <div className="reset-credit-content">
                  <p>可用重置次数<strong>{payload.resetCreditsCount} 次</strong></p>
                  {resetCredits?.length ? (
                    <ul className="reset-credit-list" aria-label="重置机会到期时间">
                      {resetCredits.map((credit, index) => (
                        <li key={credit.id || `${credit.expiresAt}-${index}`} title={credit.description || credit.title || undefined}>
                          <span>{credit.title || `重置机会 ${index + 1}`}</span>
                          <time dateTime={expiryDateTimeAttribute(credit.expiresAt)}>{expiryDateTime(credit.expiresAt)}</time>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {payload.resetCreditsCount > 0 && resetCredits == null ? (
                    <small className="reset-credit-note">服务未返回到期明细</small>
                  ) : null}
                  {missingResetCreditDetails > 0 && resetCredits != null ? (
                    <small className="reset-credit-note">另有 {missingResetCreditDetails} 次未返回到期明细</small>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="limits-grid">
            {orderedLimits.map((limit) => (
              <Card className="limit-card" size="sm" key={limit.id}>
                <CardHeader>
                  <CardTitle>{limit.name || (limit.id === 'codex' ? 'Codex' : limit.id)}</CardTitle>
                  <CardDescription>{limit.id}</CardDescription>
                  <CardAction><Badge variant={limit.reachedType ? 'destructive' : 'secondary'}>{limit.planType || '当前方案'}</Badge></CardAction>
                </CardHeader>
                <CardContent className="limit-card-content">
                  {limit.primary ? <WindowUsage fallbackTitle="短期额度" window={limit.primary} /> : null}
                  {limit.secondary ? <WindowUsage fallbackTitle="长期额度" window={limit.secondary} /> : null}
                  {limit.individualLimit ? (
                    <div className="individual-limit"><span>个人额度</span><strong>{limit.individualLimit.remainingPercent}% 可用</strong><small>{limit.individualLimit.used} / {limit.individualLimit.limit}</small></div>
                  ) : null}
                  {limit.credits ? (
                    <div className="limit-credits"><WalletCards /><span>附加点数</span><strong>{limit.credits.unlimited ? '无限' : limit.credits.hasCredits ? limit.credits.balance || '可用' : '未启用'}</strong></div>
                  ) : null}
                  {limit.spendControlReached ? <div className="limit-reached">当前账户已达到支出控制上限</div> : null}
                </CardContent>
              </Card>
            ))}
          </div>

          {!orderedLimits.length ? <div className="limits-empty"><Gauge /><h2>没有可显示的额度窗口</h2><p>当前登录方式可能不提供 ChatGPT 额度信息。</p></div> : null}

        </>
      ) : null}
    </section>
  );
}
