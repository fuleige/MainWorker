'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  Bookmark,
  Command,
  Globe2,
  Eye,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { StreamingMarkdown } from '@/components/streaming-markdown';
import { StaticMarkdown } from '@/components/copyable-code';
import { api } from '@/lib/workbench-api';
import { ArticleChange, ChatMode, ChatRunResult, ChatSession, useChat } from '@/hooks/use-chat';

const effortLabels: Record<string, string> = {
  low: '低 Low',
  medium: '中 Medium',
  high: '高 High',
  xhigh: '极高 XHigh',
  max: '最大 Max',
  ultra: '极限 Ultra',
};

type ChatWorkspaceProps = {
  scope: 'workspace' | 'articles' | 'article';
  articlePath?: string | null;
  sourceId?: string | null;
  title: string;
  subtitle: string;
  compact?: boolean;
  enabled?: boolean;
  onUnauthorized?: () => void;
  sessionId?: number | null;
  onSessionUrlChange?: (sessionId: number | null, historyMode: 'push' | 'replace') => void;
  promptRequest?: { id: number; text: string; send: boolean } | null;
  onRunComplete?: (result: ChatRunResult) => void;
  onBusyChange?: (busy: boolean) => void;
  onArticleChanged?: () => void;
};

function ArticleChangeCard({ change: initialChange, sourceId, articlePath, onArticleChanged }: {
  change: ArticleChange;
  sourceId?: string | null;
  articlePath?: string | null;
  onArticleChanged?: () => void;
}) {
  const [change, setChange] = useState(initialChange);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState<{ beforeSource: string; afterSource: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function viewRevision() {
    if (!sourceId || !articlePath) return;
    setOpen(true);
    if (revision) return;
    setLoading(true);
    setError('');
    try {
      const payload = await api<{ beforeSource: string; afterSource: string }>(`/api/article/revision?source=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(articlePath)}&revision=${change.revisionId}`);
      setRevision(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '修改记录读取失败');
    } finally {
      setLoading(false);
    }
  }

  async function undoRevision() {
    if (!sourceId || !articlePath || !change.canUndo || !window.confirm('撤销这次 AI 对 Markdown 的修改吗？如果文件后来又有更新，系统会自动阻止覆盖。')) return;
    setLoading(true);
    setError('');
    try {
      const payload = await api<{ change: ArticleChange }>('/api/article/revision/undo', {
        method: 'POST', body: JSON.stringify({ sourceId, path: articlePath, revisionId: change.revisionId }),
      });
      setChange(payload.change);
      onArticleChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤销失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`article-change-card ${change.revertedAt ? 'is-reverted' : ''}`}>
      <div><strong>{change.revertedAt ? '这次 Markdown 修改已撤销' : 'AI 已更新 Markdown 文件'}</strong><small>{change.revertedAt ? '原文已安全恢复' : '可查看修改前后全文，或安全撤销本次修改'}</small></div>
      <span><Button variant="outline" size="sm" onClick={() => void viewRevision()}><Eye />查看改动</Button><Button variant="ghost" size="sm" disabled={!change.canUndo || loading} onClick={() => void undoRevision()}><RotateCcw />撤销</Button></span>
      {error ? <p role="alert">{error}</p> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="article-revision-dialog">
          <DialogHeader><DialogTitle>本次 Markdown 改动</DialogTitle><DialogDescription>左侧是修改前，右侧是修改后；这里只读，不会直接编辑原文。</DialogDescription></DialogHeader>
          {loading && !revision ? <div className="revision-loading"><LoaderCircle className="spin" />正在读取改动…</div> : null}
          {error && !revision ? <div className="chat-inline-error">{error}</div> : null}
          {revision ? <div className="article-revision-columns"><section><h3>修改前</h3><pre>{revision.beforeSource}</pre></section><section><h3>修改后</h3><pre>{revision.afterSource}</pre></section></div> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionList({
  sessions, current, deletingId, onSelect, onCreate, onDelete,
}: {
  sessions: ChatSession[];
  current: ChatSession | null;
  deletingId: number | null;
  onSelect: (session: ChatSession) => void;
  onCreate: () => void;
  onDelete: (session: ChatSession) => void;
}) {
  return (
    <div className="session-list-wrap">
      <div className="sidebar-label"><span>最近对话</span><span>{sessions.length}</span></div>
      <nav className="conversation-list" aria-label="对话列表">
        {sessions.map((session) => (
          <div className={`conversation-row ${session.id === current?.id ? 'is-active' : ''}`} key={session.id}>
            <button className="conversation-item" onClick={() => onSelect(session)} type="button">
              <span className="conversation-name"><strong>{session.title}</strong>{session.running && <i />}</span>
              <span>{session.mode === 'quick' ? '快速问答' : '工作模式'} · {session.turnCount ? `${session.turnCount} 轮` : '尚未开始'}</span>
            </button>
            <Button
              className="conversation-delete"
              variant="ghost"
              size="icon-sm"
              disabled={session.running || deletingId === session.id}
              onClick={() => onDelete(session)}
              aria-label={`删除会话 ${session.title}`}
              title={session.running ? '运行中的会话不能删除' : `删除“${session.title}”`}
            >
              {deletingId === session.id ? <LoaderCircle className="spin" /> : <Trash2 />}
            </Button>
          </div>
        ))}
      </nav>
      <div className="session-list-actions">
        <Button variant="outline" onClick={onCreate}><Plus />新会话</Button>
      </div>
    </div>
  );
}

function ConversationModeSwitch({
  mode, onChange,
}: {
  mode: ChatMode;
  onChange: (mode: ChatMode) => void;
}) {
  return (
    <div className="conversation-mode-switch" aria-label="对话模式">
      <button type="button" className={mode === 'work' ? 'is-active' : ''} aria-pressed={mode === 'work'} onClick={() => mode !== 'work' && onChange('work')} title="切换时新建一个工作模式会话">
        <Command />工作模式
      </button>
      <button type="button" className={mode === 'quick' ? 'is-active is-quick' : ''} aria-pressed={mode === 'quick'} onClick={() => mode !== 'quick' && onChange('quick')} title="切换时新建一个快速问答会话">
        <Globe2 />快速问答
      </button>
    </div>
  );
}

function QuickPhrases({ onUse }: { onUse: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [phrases, setPhrases] = useState<Array<{ id: number; text: string }>>([]);
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) void api<{ phrases: Array<{ id: number; text: string }> }>('/api/quick-phrases').then((payload) => setPhrases(payload.phrases));
  }, [open]);

  async function addPhrase() {
    if (!text.trim()) return;
    const payload = await api<{ phrase: { id: number; text: string } }>('/api/quick-phrases', {
      method: 'POST', body: JSON.stringify({ text: text.trim() }),
    });
    setPhrases((items) => [payload.phrase, ...items]);
    setText('');
  }

  async function removePhrase(id: number) {
    await api('/api/quick-phrases', { method: 'DELETE', body: JSON.stringify({ id }) });
    setPhrases((items) => items.filter((item) => item.id !== id));
  }

  return (
    <>
      <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(true)}><Bookmark />短语</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="phrase-dialog">
          <DialogHeader><DialogTitle>快捷短语</DialogTitle><DialogDescription>保存常用的审核或处理指令。</DialogDescription></DialogHeader>
          <div className="phrase-create"><Input value={text} onChange={(event) => setText(event.target.value)} placeholder="输入新的快捷短语" /><Button onClick={addPhrase}>添加</Button></div>
          <div className="phrase-list">
            {phrases.length ? phrases.map((phrase) => (
              <div key={phrase.id}><button type="button" onClick={() => { onUse(phrase.text); setOpen(false); }}>{phrase.text}</button><Button variant="ghost" size="icon-xs" onClick={() => removePhrase(phrase.id)}><Trash2 /></Button></div>
            )) : <p>还没有快捷短语。</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const chat = useChat(props);
  const { onBusyChange, promptRequest } = props;
  const sendChat = chat.send;
  const [draft, setDraft] = useState('');
  const draftStorageKey = `mainworker:composer-draft:${props.scope}:${props.sourceId || ''}:${props.articlePath || ''}`;
  const draftRef = useRef('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const messageStage = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const handledPromptRequest = useRef<number | null>(null);
  const quickMode = props.scope === 'workspace' && chat.currentMode === 'quick';
  const newSession = props.scope === 'workspace' && !chat.currentSession && !chat.missingSessionId;

  useEffect(() => {
    let restoredDraft = '';
    try {
      restoredDraft = localStorage.getItem(draftStorageKey) || '';
    } catch {
      // Draft persistence is optional when storage is unavailable.
    }
    draftRef.current = restoredDraft;
    queueMicrotask(() => setDraft(restoredDraft));
  }, [draftStorageKey]);

  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
    try {
      if (value) localStorage.setItem(draftStorageKey, value);
      else localStorage.removeItem(draftStorageKey);
    } catch {
      // Keep the in-memory draft usable when storage is unavailable.
    }
  }, [draftStorageKey]);

  useEffect(() => {
    onBusyChange?.(chat.sending || chat.loading);
  }, [chat.loading, chat.sending, onBusyChange]);

  useEffect(() => {
    const request = promptRequest;
    if (!request || handledPromptRequest.current === request.id || (request.send && chat.sending)) return;
    handledPromptRequest.current = request.id;
    queueMicrotask(() => {
      if (request.send) {
        followLatest.current = true;
        setShowScrollToBottom(false);
        void sendChat(request.text);
      } else updateDraft(request.text);
    });
  }, [chat.sending, promptRequest, sendChat, updateDraft]);

  useEffect(() => {
    if (props.compact) return;
    queueMicrotask(() => setSidebarCollapsed(localStorage.getItem('mainworker:chat-sidebar-collapsed') === '1'));
  }, [props.compact]);

  useEffect(() => {
    const stage = messageStage.current;
    if (!stage || !followLatest.current) return;
    const frame = requestAnimationFrame(() => {
      stage.scrollTo({ top: stage.scrollHeight, behavior: 'auto' });
      lastScrollTop.current = stage.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [chat.messages, chat.activity]);

  useEffect(() => {
    followLatest.current = true;
    lastScrollTop.current = 0;
    const frame = requestAnimationFrame(() => setShowScrollToBottom(false));
    return () => cancelAnimationFrame(frame);
  }, [chat.currentSession?.id]);

  useEffect(() => {
    if (props.scope !== 'workspace') return;
    document.title = chat.missingSessionId
      ? '会话不可用 · MainWorker'
      : chat.currentSession
        ? `${chat.currentSession.title} · MainWorker`
        : '新对话 · MainWorker';
  }, [chat.currentSession, chat.missingSessionId, props.scope]);

  function handleMessageScroll() {
    const stage = messageStage.current;
    if (!stage) return;
    const movedUp = stage.scrollTop < lastScrollTop.current - 1;
    const atBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight <= 8;
    if (movedUp) followLatest.current = false;
    else if (atBottom) followLatest.current = true;
    lastScrollTop.current = stage.scrollTop;
    setShowScrollToBottom(!followLatest.current || !atBottom);
  }

  function scrollToLatest() {
    const stage = messageStage.current;
    if (!stage) return;
    followLatest.current = true;
    setShowScrollToBottom(false);
    stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' });
  }

  async function removeSession(session: ChatSession) {
    if (session.running || !window.confirm(`确定删除会话“${session.title}”吗？此操作会同时删除本地对话记录。`)) return;
    setDeletingId(session.id);
    try {
      await chat.deleteSession(session);
    } finally {
      setDeletingId(null);
    }
  }

  function sendDraft() {
    const message = draft.trim();
    if (!message) return;
    followLatest.current = true;
    setShowScrollToBottom(false);
    updateDraft('');
    void chat.send(message);
  }

  function startNewSession(mode: ChatMode = 'work', clearDraft = true) {
    if (clearDraft) updateDraft('');
    followLatest.current = true;
    setShowScrollToBottom(false);
    void chat.startNewSession(mode);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem('mainworker:chat-sidebar-collapsed', next ? '1' : '0');
      return next;
    });
  }

  const selectedModel = chat.models.find((model) => model.id === chat.currentModel)
    || chat.models.find((model) => model.isDefault)
    || chat.models[0];
  const modelControls = !props.compact && props.scope === 'workspace' ? (
    <div className={`model-controls ${chat.settingsSaving ? 'is-saving' : ''}`} aria-label="模型设置">
      <NativeSelect
        className="model-picker"
        size="sm"
        value={chat.currentModel || ''}
        disabled={chat.sending || chat.settingsSaving}
        onChange={(event) => {
          const model = event.target.value;
          const target = chat.models.find((item) => item.id === model);
          if (!target) return;
          const currentEffort = chat.currentReasoningEffort || '';
          const compatibleEffort = target.reasoningEfforts.some((effort) => effort.id === currentEffort)
            ? currentEffort
            : target.defaultReasoningEffort;
          void chat.updateSessionSettings(model, compatibleEffort);
        }}
        aria-label="选择模型"
        title="选择当前会话使用的模型"
      >
        {chat.models.length
          ? chat.models.map((model) => <NativeSelectOption key={model.id} value={model.id}>{model.name}</NativeSelectOption>)
          : <NativeSelectOption value={chat.currentModel || ''}>{chat.currentModel || '正在读取模型'}</NativeSelectOption>}
      </NativeSelect>
      <NativeSelect
        className="effort-picker"
        size="sm"
        value={chat.currentReasoningEffort || ''}
        disabled={chat.sending || chat.settingsSaving || !selectedModel}
        onChange={(event) => void chat.updateSessionSettings(chat.currentModel || '', event.target.value)}
        aria-label="选择推理强度"
        title="选择当前会话使用的推理强度"
      >
        {selectedModel?.reasoningEfforts.length
          ? selectedModel.reasoningEfforts.map((effort) => <NativeSelectOption key={effort.id} value={effort.id}>{effortLabels[effort.id] || effort.id}</NativeSelectOption>)
          : <NativeSelectOption value={chat.currentReasoningEffort || ''}>{effortLabels[chat.currentReasoningEffort || ''] || chat.currentReasoningEffort || '正在读取强度'}</NativeSelectOption>}
      </NativeSelect>
    </div>
  ) : null;

  const sessionList = (
    <SessionList sessions={chat.sessions} current={chat.currentSession} deletingId={deletingId} onSelect={(session) => void chat.selectSession(session)} onCreate={() => startNewSession()} onDelete={(session) => void removeSession(session)} />
  );

  return (
    <section className={`chat-workspace ${props.compact ? 'is-compact' : ''} ${sidebarCollapsed && !props.compact ? 'is-sidebar-collapsed' : ''}`}>
      {!props.compact && (
        <aside className={`conversation-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
          {sidebarCollapsed ? (
            <div className="collapsed-sidebar-actions">
              <Button className="sidebar-expand" variant="ghost" size="icon-sm" onClick={toggleSidebar} aria-label="展开会话列表" title="展开会话列表"><PanelLeftOpen /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => startNewSession()} aria-label="新会话" title="新会话"><Plus /></Button>
            </div>
          ) : (
            <>
              <header className="sidebar-header"><div><p className="overline">MAIN WORKER</p><h1>对话</h1></div><div className="sidebar-header-actions"><Button variant="outline" size="icon" onClick={() => startNewSession()} aria-label="新会话" title="新会话"><Plus /></Button><Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="折叠会话列表" title="折叠会话列表"><PanelLeftClose /></Button></div></header>
              <div className="workspace-picker static"><span className="workspace-icon"><Command /></span><span><strong>MainWorker</strong><small>当前工作目录</small></span></div>
              {sessionList}
              <footer className="sidebar-footer"><span className={`status-dot ${chat.error ? 'is-error' : ''}`} /><span>{chat.error || 'Codex App Server 就绪'}</span></footer>
            </>
          )}
        </aside>
      )}

      <div className="chat-surface">
        <header className="chat-header">
          {!props.compact && (
            <Sheet>
              <SheetTrigger render={<Button className="mobile-menu" variant="ghost" size="icon" />}><Menu /><span className="sr-only">打开会话列表</span></SheetTrigger>
              <SheetContent side="left" className="mobile-session-sheet"><SheetHeader><SheetTitle>最近对话</SheetTitle><SheetDescription>选择或创建一个永久会话</SheetDescription></SheetHeader>{sessionList}</SheetContent>
            </Sheet>
          )}
          <div className={`chat-title ${quickMode ? 'is-quick' : ''}`}><span className="title-icon">{quickMode ? <Globe2 /> : <Sparkles />}</span><div><h2>{newSession ? '新会话' : quickMode ? '快速问答' : props.title}</h2><p>{newSession ? (quickMode ? '快速问答 · 联网搜索' : '工作模式 · 当前工作目录') : quickMode ? '联网搜索 · 不访问本地文件' : props.subtitle}</p></div></div>
          {props.compact ? (
            <div className="compact-session-actions">
              <NativeSelect value={chat.currentSession?.id || ''} onChange={(event) => { const item = chat.sessions.find((session) => session.id === Number(event.target.value)); if (item) void chat.selectSession(item); }} aria-label="选择会话">
                {chat.sessions.map((session) => <NativeSelectOption key={session.id} value={session.id}>{session.title}</NativeSelectOption>)}
              </NativeSelect>
              <Button variant="ghost" size="icon-sm" onClick={() => startNewSession()} aria-label="新建审核会话" title="新建会话"><Plus /></Button>
              <Button variant="ghost" size="icon-sm" disabled={!chat.currentSession || chat.currentSession.running || deletingId === chat.currentSession.id} onClick={() => { if (chat.currentSession) void removeSession(chat.currentSession); }} aria-label="删除当前审核会话" title="删除当前会话"><Trash2 /></Button>
            </div>
          ) : <span className={`connection-state ${chat.sending ? 'is-working' : ''}`}><i />{chat.sending ? chat.activity : '就绪'}</span>}
        </header>

        <div className="message-stage-shell">
          <div className="message-stage" ref={messageStage} onScroll={handleMessageScroll}>
            <div className="message-thread">
              {chat.error && <div className="chat-inline-error" role="alert">{chat.error}</div>}
              {chat.loading ? <div className="chat-empty"><LoaderCircle className="spin" /><p>正在恢复永久会话…</p></div> : null}
              {!chat.loading && chat.missingSessionId ? (
                <div className="chat-empty is-missing-session"><span><MessageSquareText /></span><h3>会话不可用</h3><p>会话 {chat.missingSessionId} 不存在或已经被删除。地址没有被改成新会话，以免掩盖问题。</p><Button variant="outline" onClick={() => startNewSession()}><Plus />打开新对话</Button></div>
              ) : null}
              {!chat.loading && !chat.missingSessionId && !chat.messages.length ? (
                <div className={`chat-empty ${quickMode ? 'is-quick' : ''}`}><span>{quickMode ? <Globe2 /> : <MessageSquareText />}</span><h3>{newSession ? '新会话' : quickMode ? '直接问我' : '从这里开始'}</h3><p>{quickMode ? '适合简单问题；需要最新信息时会自动联网搜索。' : props.scope === 'article' ? '让 Codex 审核、改写或直接修改当前文章。' : props.scope === 'articles' ? '从整个文章库范围整理、检查和规划内容。' : '选择模式后直接输入；发送第一条消息时才会保存这个会话。'}</p></div>
              ) : null}
              {chat.messages.map((message) => (
                <article className={`message ${message.role === 'user' ? 'user-message' : 'agent-message'} ${message.status === 'failed' ? 'is-error' : ''}`} key={message.id}>
                  <div className="message-meta">{message.role === 'assistant' && <span className="agent-avatar"><Sparkles /></span>}<span>{message.role === 'user' ? '你' : 'Codex'}</span></div>
                  {message.role === 'user' ? <p>{message.text}</p> : (
                    message.html
                      ? <StaticMarkdown className={`agent-copy markdown-body ${message.status === 'inProgress' ? 'is-streaming' : ''}`} html={message.html} />
                      : <div className={`agent-copy markdown-body ${message.status === 'inProgress' ? 'is-streaming' : ''}`}><StreamingMarkdown source={message.text} /></div>
                  )}
                  {message.role === 'assistant' && message.articleChange ? <ArticleChangeCard change={message.articleChange} sourceId={props.sourceId} articlePath={props.articlePath} onArticleChanged={props.onArticleChanged} /> : null}
                </article>
              ))}
              {chat.sending && <div className="run-status"><LoaderCircle className="spin" /><span>{chat.activity}</span><Button variant="ghost" size="sm" onClick={() => void chat.interrupt()}><Square />停止</Button></div>}
              <div />
            </div>
          </div>
          {showScrollToBottom && <Button className="scroll-to-bottom" variant="outline" size="sm" onClick={scrollToLatest} aria-label="回到最新消息" title="回到底部"><ArrowDown /><span>回到底部</span></Button>}
        </div>

        <div className="composer-wrap">
          {!props.compact && props.scope === 'workspace' && <ConversationModeSwitch mode={chat.currentMode} onChange={(mode) => startNewSession(mode, false)} />}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); sendDraft(); }}>
            <Textarea value={draft} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendDraft(); } }} disabled={chat.sending || Boolean(chat.missingSessionId)} aria-label="发送消息" placeholder={chat.missingSessionId ? '请先打开一个新对话' : chat.sending ? 'Codex 正在处理当前任务…' : quickMode ? '输入一个问题，需要时会联网搜索…' : '交给 Codex 处理…'} rows={3} />
            <div className="composer-footer"><QuickPhrases onUse={(text) => updateDraft(draftRef.current ? `${draftRef.current}\n${text}` : text)} />{modelControls}<span className="shortcut"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd><kbd>Enter</kbd> 换行</span><Button type="submit" size="icon-lg" disabled={!draft.trim() || chat.sending || Boolean(chat.missingSessionId)} aria-label="发送"><Send /></Button></div>
          </form>
          {!props.compact && <p className={`composer-note ${quickMode ? 'is-quick' : ''}`}>{quickMode ? '快速问答不会执行本地命令或修改文件' : 'Codex 可以读取和修改当前工作目录中的文件'}</p>}
        </div>
      </div>
    </section>
  );
}
