'use client';

import { SyntheticEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarCheck, CheckCircle2, Circle, Clock3, Flag, Inbox, ListTodo, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { api } from '@/lib/workbench-api';

type Task = {
  id: number;
  title: string;
  notes: string;
  status: 'inbox' | 'todo' | 'doing' | 'done';
  priority: 'low' | 'medium' | 'high';
  dueDate: string | null;
  project: string;
  parentId: number | null;
  createdAt: string;
  updatedAt: string;
};

type Filter = 'today' | 'upcoming' | 'all' | 'done';

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function taskDateLabel(date: string | null) {
  if (!date) return '无截止日期';
  const today = localDate();
  if (date === today) return '今天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`));
}

export function PlannerModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(localDate());
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [project, setProject] = useState('');
  const [childParentId, setChildParentId] = useState<number | null>(null);
  const [childTitle, setChildTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handleError = useCallback((caught: unknown) => {
    if ((caught as { status?: number }).status === 401) onUnauthorized();
    else setError(caught instanceof Error ? caught.message : '操作失败');
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    try {
      const payload = await api<{ tasks: Task[] }>('/api/planner/tasks');
      setTasks(payload.tasks);
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const createTask = useCallback(async (input: { title: string; dueDate?: string | null; priority?: Task['priority']; project?: string; parentId?: number | null }) => {
    const payload = await api<{ task: Task }>('/api/planner/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: input.title, dueDate: input.dueDate || null, priority: input.priority || 'medium', project: input.project || '', parentId: input.parentId || null, status: 'todo' }),
    });
    setTasks((items) => [payload.task, ...items]);
    return payload.task;
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    try {
      await createTask({ title: title.trim(), dueDate, priority, project: project.trim() });
      setTitle('');
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function submitChild(event: SyntheticEvent<HTMLFormElement>, parent: Task) {
    event.preventDefault();
    if (!childTitle.trim()) return;
    try {
      await createTask({ title: childTitle.trim(), parentId: parent.id, project: parent.project || parent.title });
      setChildTitle('');
      setChildParentId(null);
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function updateTask(id: number, changes: Partial<Task>) {
    try {
      const payload = await api<{ task: Task }>(`/api/planner/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      setTasks((items) => items.map((item) => item.id === id ? payload.task : item));
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  async function deleteTask(id: number) {
    try {
      await api(`/api/planner/tasks/${id}`, { method: 'DELETE' });
      setTasks((items) => items.filter((item) => item.id !== id));
      setError('');
    } catch (caught) {
      handleError(caught);
    }
  }

  useEffect(() => {
    type Tool = { name: string; title: string; description: string; inputSchema: object; annotations: object; execute: (input: Record<string, unknown>) => Promise<unknown> };
    type ModelContext = { registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tool: Tool = {
      name: 'planner_create_task',
      title: '添加规划任务',
      description: '在当前个人规划中创建一项真实任务。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 240 },
          dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD 或 null' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          project: { type: 'string' },
          parentId: { type: ['integer', 'null'], description: '可选的父任务编号；提供后会创建为该任务的子任务' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const inputTitle = typeof input.title === 'string' ? input.title.trim() : '';
        const inputDueDate = typeof input.dueDate === 'string' ? input.dueDate : null;
        const inputPriority = typeof input.priority === 'string' ? input.priority : '';
        const inputProject = typeof input.project === 'string' ? input.project : '';
        const task = await createTask({
          title: inputTitle,
          dueDate: inputDueDate,
          priority: ['low', 'medium', 'high'].includes(inputPriority) ? inputPriority as Task['priority'] : 'medium',
          project: inputProject,
          parentId: typeof input.parentId === 'number' ? input.parentId : null,
        });
        return { id: task.id, title: task.title, status: task.status };
      },
    };
    try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Unsupported host. */ }
    return () => lifecycle.abort();
  }, [createTask]);

  const today = localDate();
  const taskMatchesFilter = useCallback((task: Task) => {
    if (filter === 'done') return task.status === 'done';
    if (filter === 'all') return true;
    if (filter === 'upcoming') return task.status !== 'done' && Boolean(task.dueDate && task.dueDate > today);
    return task.status !== 'done' && Boolean(task.dueDate && task.dueDate <= today);
  }, [filter, today]);
  const childrenByParent = useMemo(() => {
    const grouped = new Map<number, Task[]>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      const children = grouped.get(task.parentId) || [];
      children.push(task);
      grouped.set(task.parentId, children);
    }
    return grouped;
  }, [tasks]);
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const rootTasks = useMemo(() => tasks.filter((task) => !task.parentId || !taskIds.has(task.parentId)), [taskIds, tasks]);

  function branchMatchesFilter(task: Task): boolean {
    return taskMatchesFilter(task) || (childrenByParent.get(task.id) || []).some(branchMatchesFilter);
  }

  const visibleRootTasks = rootTasks.filter(branchMatchesFilter);
  const visibleCount = tasks.filter(taskMatchesFilter).length;
  const todayCount = tasks.filter((task) => task.status !== 'done' && task.dueDate && task.dueDate <= today).length;
  const doingCount = tasks.filter((task) => task.status === 'doing').length;
  const doneCount = tasks.filter((task) => task.status === 'done').length;

  function renderTask(task: Task, depth = 0) {
    const children = (childrenByParent.get(task.id) || []).filter(branchMatchesFilter);
    const directChildren = childrenByParent.get(task.id) || [];
    const completedChildren = directChildren.filter((child) => child.status === 'done').length;
    return (
      <div className={`task-branch ${depth ? 'is-child' : 'is-root'}`} key={task.id}>
        <article className={`task-item ${task.status === 'done' ? 'is-done' : ''}`}>
          <Checkbox checked={task.status === 'done'} onCheckedChange={(checked) => void updateTask(task.id, { status: checked ? 'done' : 'todo' })} aria-label={`完成 ${task.title}`} />
          <div className="task-copy">
            <strong>{task.title}</strong>
            <div>
              {task.project && <span className="task-project">{task.project}</span>}
              {directChildren.length ? <span className="subtask-count">{completedChildren}/{directChildren.length} 子任务</span> : null}
              <span className={`priority ${task.priority}`}><Flag />{task.priority === 'high' ? '高' : task.priority === 'low' ? '低' : '中'}</span>
              <time>{taskDateLabel(task.dueDate)}</time>
            </div>
          </div>
          <div className="task-actions">
            <Button variant="ghost" size="xs" onClick={() => { setChildParentId((current) => current === task.id ? null : task.id); setChildTitle(''); }} aria-expanded={childParentId === task.id}><Plus />子任务</Button>
            {task.status !== 'done' && <Button className="task-status-action" variant="ghost" size="sm" onClick={() => void updateTask(task.id, { status: task.status === 'doing' ? 'todo' : 'doing' })}>{task.status === 'doing' ? <><Circle />移出进行中</> : <><ListTodo />开始</>}</Button>}
            <Button variant="ghost" size="icon-sm" onClick={() => void deleteTask(task.id)} aria-label={`删除任务 ${task.title}`}><Trash2 /></Button>
          </div>
        </article>
        {childParentId === task.id ? (
          <form className="subtask-create" onSubmit={(event) => void submitChild(event, task)}>
            <span aria-hidden="true">↳</span>
            <Input value={childTitle} onChange={(event) => setChildTitle(event.target.value)} placeholder={`添加“${task.title}”的子任务…`} aria-label={`${task.title} 的新子任务`} />
            <Button type="submit" size="sm" disabled={!childTitle.trim()}>添加</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setChildParentId(null); setChildTitle(''); }}>取消</Button>
          </form>
        ) : null}
        {children.length ? <div className="task-children">{children.map((child) => renderTask(child, depth + 1))}</div> : null}
      </div>
    );
  }

  return (
    <section className="planner-module">
      <header className="planner-header">
        <div><p className="overline">PERSONAL PLAN</p><h1>个人规划</h1><p>把要做的事收进来，再决定今天真正推进什么。</p></div>
        <div className="planner-date"><CalendarCheck /><span>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span></div>
      </header>

      <div className="planner-overview">
        <div><span className="overview-icon warm"><Clock3 /></span><p>今日待办<strong>{todayCount}</strong></p></div>
        <div><span className="overview-icon green"><ListTodo /></span><p>正在进行<strong>{doingCount}</strong></p></div>
        <div><span className="overview-icon gray"><CheckCircle2 /></span><p>累计完成<strong>{doneCount}</strong></p></div>
      </div>

      <form className="task-create" onSubmit={submit}>
        <span className="task-create-plus"><Plus /></span>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="添加一个长期方向…" aria-label="任务标题" />
        <Input value={project} onChange={(event) => setProject(event.target.value)} placeholder="所属项目" aria-label="所属项目" />
        <Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="截止日期" />
        <NativeSelect value={priority} onChange={(event) => setPriority(event.target.value as Task['priority'])} aria-label="优先级"><NativeSelectOption value="high">高优先级</NativeSelectOption><NativeSelectOption value="medium">中优先级</NativeSelectOption><NativeSelectOption value="low">低优先级</NativeSelectOption></NativeSelect>
        <Button type="submit" disabled={!title.trim()}>添加</Button>
      </form>

      <div className="planner-content">
        <nav className="planner-filters" aria-label="任务筛选">
          <button className={filter === 'today' ? 'is-active' : ''} onClick={() => setFilter('today')}><CalendarCheck />今天<span>{todayCount}</span></button>
          <button className={filter === 'upcoming' ? 'is-active' : ''} onClick={() => setFilter('upcoming')}><Clock3 />稍后</button>
          <button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}><Inbox />全部</button>
          <button className={filter === 'done' ? 'is-active' : ''} onClick={() => setFilter('done')}><CheckCircle2 />已完成</button>
        </nav>

        <div className="task-board">
          <div className="task-board-head"><div><h2>{filter === 'today' ? '今天' : filter === 'upcoming' ? '稍后' : filter === 'done' ? '已完成' : '全部任务'}</h2><p>{visibleRootTasks.length} 个方向 · {visibleCount} 项任务</p></div></div>
          {error && <div className="planner-error">{error}</div>}
          {loading ? <div className="planner-empty">正在读取规划…</div> : null}
          {!loading && !visibleRootTasks.length ? <div className="planner-empty"><CalendarCheck /><h3>这里还很清静</h3><p>在上方添加一项任务，或者切换到其他列表。</p></div> : null}
          <div className="task-list">{visibleRootTasks.map((task) => renderTask(task))}</div>
        </div>
      </div>
    </section>
  );
}
