'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, chatQuery, parseSse } from '@/lib/workbench-api';

export type ChatMode = 'work' | 'quick';

export type ChatSession = {
  id: number;
  scope: string;
  contextKey: string;
  threadId: string | null;
  title: string;
  mode: ChatMode;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  running: boolean;
};

export type ChatModel = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  reasoningEfforts: Array<{ id: string; description: string }>;
};

type ChatModelCatalog = {
  models: ChatModel[];
  defaultModel: string;
  defaultReasoningEffort: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  html?: string;
  status?: string;
};

type ActiveRun = {
  runId: string;
  turnId?: string | null;
  threadId?: string | null;
  userText?: string;
  assistantText?: string;
  seq?: number;
};

type UseChatOptions = {
  scope: 'workspace' | 'articles' | 'article';
  articlePath?: string | null;
  sourceId?: string | null;
  enabled?: boolean;
  onUnauthorized?: () => void;
};

type StoredTurn = {
  turn_id: string;
  user_text: string;
  assistant_text: string;
  assistantHtml?: string;
  status: string;
  error?: string | null;
};

function eventText(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function useChat({ scope, articlePath, sourceId, enabled = true, onUnauthorized }: UseChatOptions) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState('');
  const [draftMode, setDraftMode] = useState<ChatMode>('work');
  const [draftModel, setDraftModel] = useState('');
  const [draftReasoningEffort, setDraftReasoningEffort] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState('就绪');
  const [error, setError] = useState('');
  const initializedKey = useRef('');
  const activeRef = useRef<ActiveRun | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const scopeRef = useRef({ scope, articlePath, sourceId });
  const draftModeRef = useRef<ChatMode>('work');

  useEffect(() => {
    scopeRef.current = { scope, articlePath, sourceId };
  }, [articlePath, scope, sourceId]);

  useEffect(() => {
    if (!enabled || scope !== 'workspace') return;
    void api<ChatModelCatalog>('/api/chat/models')
      .then((payload) => {
        setModels(payload.models);
        setDefaultModel(payload.defaultModel);
        setDefaultReasoningEffort(payload.defaultReasoningEffort);
        const model = payload.models.find((item) => item.id === payload.defaultModel) || payload.models[0];
        setDraftModel(model?.id || '');
        setDraftReasoningEffort(
          draftModeRef.current === 'quick' && model?.reasoningEfforts.some((effort) => effort.id === 'low')
            ? 'low'
            : payload.defaultReasoningEffort || model?.defaultReasoningEffort || '',
        );
      })
      .catch(() => setModels([]));
  }, [enabled, scope]);

  const handleError = useCallback((caught: unknown) => {
    const problem = caught instanceof Error ? caught : new Error('请求失败');
    if (problem instanceof ApiError && problem.status === 401) onUnauthorized?.();
    setError(problem.message);
    setSending(false);
    setActivity('连接中断');
  }, [onUnauthorized]);

  const setAssistant = useCallback((id: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  }, []);

  const consume = useCallback(async (response: Response, assistantId: string) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(payload.error || `请求失败（${response.status}）`, response.status);
    }
    if (!response.body) throw new Error('浏览器不支持流式响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSse(buffer, (event, payload) => {
        const seq = Number(payload.seq || 0);
        if (activeRef.current) activeRef.current.seq = Math.max(activeRef.current.seq || 0, seq);
        if (event === 'run') {
          activeRef.current = { runId: eventText(payload.runId), seq };
          setSending(true);
        }
        if (event === 'meta' && activeRef.current) {
          activeRef.current.turnId = eventText(payload.turnId);
          activeRef.current.threadId = eventText(payload.threadId);
        }
        if (event === 'activity') setActivity(eventText(payload.label, '正在处理'));
        if (event === 'reasoning') setActivity('正在分析请求');
        if (event === 'snapshot') {
          if (!activeRef.current) activeRef.current = { runId: eventText(payload.runId), seq };
          activeRef.current.turnId = eventText(payload.turnId, activeRef.current.turnId || '');
          setAssistant(assistantId, (message) => ({ ...message, text: eventText(payload.text), html: undefined, status: 'inProgress' }));
        }
        if (event === 'delta') {
          const delta = eventText(payload.text);
          setAssistant(assistantId, (message) => ({ ...message, text: message.text + delta, status: 'inProgress' }));
          setActivity('正在生成回答');
        }
        if (event === 'error') {
          setActivity(eventText(payload.message, '执行失败'));
        }
        if (event === 'final') {
          setAssistant(assistantId, (message) => ({
            ...message,
            text: eventText(payload.text, eventText(payload.error, message.text)),
            html: eventText(payload.html),
            status: eventText(payload.status, 'completed'),
          }));
          activeRef.current = null;
          setSending(false);
          setActivity(payload.status === 'completed' ? '已完成' : payload.status === 'interrupted' ? '已停止' : '执行结束');
        }
      });
    }
  }, [setAssistant]);

  const follow = useCallback(async (initial: Response | null, assistantId: string, sessionId: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      if (initial) await consume(initial, assistantId);
      let retries = 0;
      while (activeRef.current && !controller.signal.aborted) {
        const current = activeRef.current;
        const context = scopeRef.current;
        const params = chatQuery(context.scope, context.articlePath, context.sourceId);
        params.set('session', String(sessionId));
        params.set('runId', current.runId);
        params.set('turnId', current.turnId || '');
        params.set('after', String(current.seq || 0));
        const response = await fetch(`/api/chat/stream?${params}`, { signal: controller.signal });
        await consume(response, assistantId);
        if (activeRef.current) {
          retries += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** retries)));
        }
      }
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') handleError(caught);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [consume, handleError]);

  const loadHistory = useCallback(async (session: ChatSession) => {
    controllerRef.current?.abort();
    activeRef.current = null;
    setSending(false);
    setError('');
    const context = scopeRef.current;
    const params = chatQuery(context.scope, context.articlePath, context.sourceId);
    params.set('session', String(session.id));
    const payload = await api<{ turns: StoredTurn[]; activeRun: ActiveRun | null }>(`/api/chat/history?${params}`);
    const restored: ChatMessage[] = [];
    for (const turn of payload.turns) {
      const turnId = turn.turn_id;
      restored.push({ id: `user-${turnId}`, role: 'user', text: turn.user_text || '' });
      if (turn.assistant_text || turn.error || payload.activeRun?.turnId === turnId) {
        restored.push({
          id: `assistant-${turnId}`,
          role: 'assistant',
          text: turn.assistant_text || turn.error || '',
          html: payload.activeRun?.turnId === turnId ? undefined : turn.assistantHtml || '',
          status: turn.status || '',
        });
      }
    }
    let activeAssistantId = '';
    if (payload.activeRun) {
      activeRef.current = payload.activeRun;
      activeAssistantId = `assistant-${payload.activeRun.turnId || payload.activeRun.runId}`;
      if (!restored.some((message) => message.id === activeAssistantId)) {
        if (!payload.activeRun.turnId) restored.push({ id: `user-${payload.activeRun.runId}`, role: 'user', text: payload.activeRun.userText || '' });
        restored.push({ id: activeAssistantId, role: 'assistant', text: payload.activeRun.assistantText || '', status: 'inProgress' });
      }
      setSending(true);
      setActivity('正在恢复运行');
    }
    setMessages(restored);
    if (payload.activeRun) void follow(null, activeAssistantId, session.id);
  }, [follow]);

  const refreshSessions = useCallback(async (preferredId?: number) => {
    const context = scopeRef.current;
    const params = chatQuery(context.scope, context.articlePath, context.sourceId);
    let payload = await api<{ sessions: ChatSession[] }>(`/api/chat/sessions?${params}`);
    if (!payload.sessions.length && context.scope !== 'workspace') {
      const created = await api<{ session: ChatSession }>('/api/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ scope: context.scope, articlePath: context.articlePath, sourceId: context.sourceId }),
      });
      payload = { sessions: [created.session] };
    }
    setSessions(payload.sessions);
    if (context.scope === 'workspace' && preferredId === undefined) {
      setCurrentSession(null);
      setMessages([]);
      return;
    }
    const storageKey = `mainworker:session:${context.scope}:${context.sourceId || ''}:${context.articlePath || ''}`;
    const savedId = Number(localStorage.getItem(storageKey));
    const selected = payload.sessions.find((item) => item.id === preferredId)
      || payload.sessions.find((item) => item.id === savedId)
      || payload.sessions[0];
    if (!selected) {
      setCurrentSession(null);
      setMessages([]);
      return;
    }
    setCurrentSession(selected);
    localStorage.setItem(storageKey, String(selected.id));
    await loadHistory(selected);
  }, [loadHistory]);

  useEffect(() => {
    const key = `${scope}:${sourceId || ''}:${articlePath || ''}:${enabled}`;
    if (!enabled || initializedKey.current === key) return;
    initializedKey.current = key;
    setLoading(true);
    setError('');
    setMessages([]);
    void refreshSessions().catch(handleError).finally(() => setLoading(false));
    return () => controllerRef.current?.abort();
  }, [articlePath, enabled, handleError, refreshSessions, scope, sourceId]);

  const selectSession = useCallback(async (session: ChatSession) => {
    setCurrentSession(session);
    const context = scopeRef.current;
    localStorage.setItem(`mainworker:session:${context.scope}:${context.sourceId || ''}:${context.articlePath || ''}`, String(session.id));
    setLoading(true);
    try { await loadHistory(session); } catch (caught) { handleError(caught); } finally { setLoading(false); }
  }, [handleError, loadHistory]);

  const startNewSession = useCallback(async (mode: ChatMode = 'work') => {
    const context = scopeRef.current;
    if (context.scope === 'workspace') {
      controllerRef.current?.abort();
      activeRef.current = null;
      draftModeRef.current = mode;
      setDraftMode(mode);
      const model = models.find((item) => item.id === defaultModel) || models[0];
      setDraftModel(model?.id || defaultModel);
      setDraftReasoningEffort(
        mode === 'quick' && model?.reasoningEfforts.some((effort) => effort.id === 'low')
          ? 'low'
          : defaultReasoningEffort || model?.defaultReasoningEffort || '',
      );
      setCurrentSession(null);
      setMessages([]);
      setSending(false);
      setActivity('就绪');
      setError('');
      return;
    }
    try {
      const payload = await api<{ session: ChatSession }>('/api/chat/sessions', {
        method: 'POST', body: JSON.stringify({ scope: context.scope, articlePath: context.articlePath, sourceId: context.sourceId, mode }),
      });
      setSessions((items) => [payload.session, ...items]);
      await selectSession(payload.session);
    } catch (caught) {
      handleError(caught);
    }
  }, [defaultModel, defaultReasoningEffort, handleError, models, selectSession]);

  const deleteSession = useCallback(async (target?: ChatSession) => {
    const session = target || currentSession;
    if (!session || session.running) return;
    try {
      const context = scopeRef.current;
      await api('/api/chat/sessions', { method: 'DELETE', body: JSON.stringify({ scope: context.scope, articlePath: context.articlePath, sourceId: context.sourceId, sessionId: session.id }) });
      const deletingCurrent = currentSession?.id === session.id;
      if (deletingCurrent) {
        setCurrentSession(null);
        setMessages([]);
      }
      await refreshSessions(deletingCurrent ? undefined : currentSession?.id);
    } catch (caught) {
      handleError(caught);
    }
  }, [currentSession, handleError, refreshSessions]);

  const updateSessionSettings = useCallback(async (model: string | null, reasoningEffort: string | null) => {
    if (settingsSaving) return;
    if (!currentSession) {
      setDraftModel(model || '');
      setDraftReasoningEffort(reasoningEffort || '');
      return;
    }
    if (currentSession.running) return;
    setSettingsSaving(true);
    setError('');
    try {
      const context = scopeRef.current;
      const payload = await api<{ session: ChatSession }>('/api/chat/sessions', {
        method: 'PATCH',
        body: JSON.stringify({
          scope: context.scope,
          articlePath: context.articlePath,
          sourceId: context.sourceId,
          sessionId: currentSession.id,
          model,
          reasoningEffort,
        }),
      });
      setCurrentSession(payload.session);
      setSessions((items) => items.map((item) => item.id === payload.session.id ? payload.session : item));
    } catch (caught) {
      handleError(caught);
    } finally {
      setSettingsSaving(false);
    }
  }, [currentSession, handleError, settingsSaving]);

  const send = useCallback(async (text: string) => {
    if (sending || !text.trim()) return;
    const temporary = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${temporary}`;
    const assistantId = `assistant-${temporary}`;
    setMessages((items) => [...items, { id: userId, role: 'user', text: text.trim() }, { id: assistantId, role: 'assistant', text: '', status: 'inProgress' }]);
    setSending(true);
    setActivity('正在连接 Codex');
    setError('');
    const context = scopeRef.current;
    try {
      let session = currentSession;
      if (!session) {
        const created = await api<{ session: ChatSession }>('/api/chat/sessions', {
          method: 'POST',
          body: JSON.stringify({
            scope: context.scope,
            articlePath: context.articlePath,
            sourceId: context.sourceId,
            mode: draftMode,
            model: draftModel,
            reasoningEffort: draftReasoningEffort,
          }),
        });
        const createdSession = created.session;
        session = createdSession;
        setCurrentSession(createdSession);
        setSessions((items) => [createdSession, ...items]);
        localStorage.setItem(`mainworker:session:${context.scope}:${context.sourceId || ''}:${context.articlePath || ''}`, String(createdSession.id));
      }
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: context.scope, articlePath: context.articlePath, sourceId: context.sourceId, sessionId: session.id, message: text.trim() }),
      });
      await follow(response, assistantId, session.id);
      await refreshSessions(session.id);
    } catch (caught) {
      handleError(caught);
      setAssistant(assistantId, (message) => ({ ...message, text: message.text || (caught as Error).message, status: 'failed' }));
    }
  }, [currentSession, draftMode, draftModel, draftReasoningEffort, follow, handleError, refreshSessions, sending, setAssistant]);

  const interrupt = useCallback(async () => {
    if (!activeRef.current) return;
    setActivity('正在停止任务');
    try {
      await api('/api/chat/interrupt', { method: 'POST', body: JSON.stringify({ runId: activeRef.current.runId }) });
    } catch (caught) {
      handleError(caught);
    }
  }, [handleError]);

  const currentMode = currentSession?.mode || draftMode;
  const currentModel = currentSession?.model || draftModel;
  const currentReasoningEffort = currentSession?.reasoningEffort || draftReasoningEffort;

  return {
    sessions, currentSession, currentMode, currentModel, currentReasoningEffort,
    messages, models, loading, sending, settingsSaving, activity, error,
    selectSession, startNewSession, deleteSession, updateSessionSettings, send, interrupt, refreshSessions,
  };
}
