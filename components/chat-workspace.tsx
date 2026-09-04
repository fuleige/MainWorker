'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  Bookmark,
  Command,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Plus,
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
import { api } from '@/lib/workbench-api';
import { ChatSession, useChat } from '@/hooks/use-chat';

type ChatWorkspaceProps = {
  scope: 'workspace' | 'articles' | 'article';
  articlePath?: string | null;
  sourceId?: string | null;
  title: string;
  subtitle: string;
  compact?: boolean;
  enabled?: boolean;
  onUnauthorized?: () => void;
};

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
              <span>{session.turnCount ? `${session.turnCount} 轮对话` : '尚未开始'}</span>
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
  const [draft, setDraft] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const messageStage = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);

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
    setDraft('');
    void chat.send(message);
  }

  const sessionList = (
    <SessionList sessions={chat.sessions} current={chat.currentSession} deletingId={deletingId} onSelect={(session) => void chat.selectSession(session)} onCreate={() => void chat.createSession()} onDelete={(session) => void removeSession(session)} />
  );

  return (
    <section className={`chat-workspace ${props.compact ? 'is-compact' : ''}`}>
      {!props.compact && (
        <aside className="conversation-sidebar">
          <header className="sidebar-header"><div><p className="overline">MAIN WORKER</p><h1>对话</h1></div><Button variant="outline" size="icon" onClick={() => void chat.createSession()}><Plus /></Button></header>
          <div className="workspace-picker static"><span className="workspace-icon"><Command /></span><span><strong>MainWorker</strong><small>当前工作目录</small></span></div>
          {sessionList}
          <footer className="sidebar-footer"><span className={`status-dot ${chat.error ? 'is-error' : ''}`} /><span>{chat.error || 'Codex App Server 就绪'}</span></footer>
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
          <div className="chat-title"><span className="title-icon"><Sparkles /></span><div><h2>{props.title}</h2><p>{props.subtitle}</p></div></div>
          {props.compact ? (
            <div className="compact-session-actions">
              <NativeSelect value={chat.currentSession?.id || ''} onChange={(event) => { const item = chat.sessions.find((session) => session.id === Number(event.target.value)); if (item) void chat.selectSession(item); }} aria-label="选择会话">
                {chat.sessions.map((session) => <NativeSelectOption key={session.id} value={session.id}>{session.title}</NativeSelectOption>)}
              </NativeSelect>
              <Button variant="ghost" size="icon-sm" onClick={() => void chat.createSession()} aria-label="新建审核会话" title="新建会话"><Plus /></Button>
              <Button variant="ghost" size="icon-sm" disabled={!chat.currentSession || chat.currentSession.running || deletingId === chat.currentSession.id} onClick={() => { if (chat.currentSession) void removeSession(chat.currentSession); }} aria-label="删除当前审核会话" title="删除当前会话"><Trash2 /></Button>
            </div>
          ) : <span className={`connection-state ${chat.sending ? 'is-working' : ''}`}><i />{chat.sending ? chat.activity : '就绪'}</span>}
        </header>

        <div className="message-stage-shell">
          <div className="message-stage" ref={messageStage} onScroll={handleMessageScroll}>
            <div className="message-thread">
              {chat.error && <div className="chat-inline-error" role="alert">{chat.error}</div>}
              {chat.loading ? <div className="chat-empty"><LoaderCircle className="spin" /><p>正在恢复永久会话…</p></div> : null}
              {!chat.loading && !chat.messages.length ? (
                <div className="chat-empty"><span><MessageSquareText /></span><h3>从这里开始</h3><p>{props.scope === 'article' ? '让 Codex 审核、改写或直接修改当前文章。' : props.scope === 'articles' ? '从整个文章库范围整理、检查和规划内容。' : '交代一个任务，对话和执行记录会在刷新后继续保留。'}</p></div>
              ) : null}
              {chat.messages.map((message) => (
                <article className={`message ${message.role === 'user' ? 'user-message' : 'agent-message'} ${message.status === 'failed' ? 'is-error' : ''}`} key={message.id}>
                  <div className="message-meta">{message.role === 'assistant' && <span className="agent-avatar"><Sparkles /></span>}<span>{message.role === 'user' ? '你' : 'Codex'}</span></div>
                  {message.role === 'user' ? <p>{message.text}</p> : (
                    message.html
                      ? <div className={`agent-copy markdown-body ${message.status === 'inProgress' ? 'is-streaming' : ''}`} dangerouslySetInnerHTML={{ __html: message.html }} />
                      : <div className={`agent-copy markdown-body ${message.status === 'inProgress' ? 'is-streaming' : ''}`}><StreamingMarkdown source={message.text} /></div>
                  )}
                </article>
              ))}
              {chat.sending && <div className="run-status"><LoaderCircle className="spin" /><span>{chat.activity}</span><Button variant="ghost" size="sm" onClick={() => void chat.interrupt()}><Square />停止</Button></div>}
              <div />
            </div>
          </div>
          {showScrollToBottom && <Button className="scroll-to-bottom" variant="outline" size="sm" onClick={scrollToLatest} aria-label="回到最新消息"><ArrowDown />回到底部</Button>}
        </div>

        <div className="composer-wrap">
          <form className="composer" onSubmit={(event) => { event.preventDefault(); sendDraft(); }}>
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendDraft(); } }} disabled={chat.sending || !chat.currentSession} aria-label="发送消息" placeholder={chat.sending ? 'Codex 正在处理当前任务…' : '交给 Codex 处理…'} rows={3} />
            <div className="composer-footer"><QuickPhrases onUse={(text) => setDraft((current) => current ? `${current}\n${text}` : text)} /><span className="shortcut"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd><kbd>Enter</kbd> 换行</span><Button type="submit" size="icon-lg" disabled={!draft.trim() || chat.sending} aria-label="发送"><Send /></Button></div>
          </form>
          {!props.compact && <p className="composer-note">Codex 可以读取和修改当前工作目录中的文件</p>}
        </div>
      </div>
    </section>
  );
}
