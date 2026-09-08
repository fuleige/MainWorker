'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, CalendarCheck, CalendarClock, CalendarDays, Check, ChevronRight,
  Flag, FolderKanban, ListChecks, LoaderCircle, MessageSquareText, Pause,
  Play, Repeat2, Sparkles,
} from 'lucide-react';
import { ChatWorkspace } from '@/components/chat-workspace';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/workbench-api';

type Project = {
  id: number;
  title: string;
  notes: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  position: number;
  createdAt: string;
  updatedAt: string;
};

type Task = {
  id: number;
  projectId: number;
  parentId: number | null;
  title: string;
  notes: string;
  status: 'todo' | 'doing' | 'done' | 'canceled' | 'skipped';
  priority: 'low' | 'medium' | 'high';
  plannedDate: string | null;
  deadlineDate: string | null;
  position: number;
  recurrenceId: number | null;
  occurrenceDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Recurrence = {
  id: number;
  projectId: number;
  title: string;
  notes: string;
  priority: Task['priority'];
  frequency: 'daily' | 'workdays' | 'weekly';
  weekdays: number[];
  startDate: string;
  endDate: string | null;
  state: 'active' | 'paused' | 'ended';
  position: number;
  currentTaskId: number | null;
  subtasks: Array<{ id: number; title: string; notes: string; priority: Task['priority']; position: number }>;
  createdAt: string;
  updatedAt: string;
};

type PlannerPayload = {
  calendar: { today: string; weekStart: string; weekEnd: string; timeZone: string };
  projects: Project[];
  tasks: Task[];
  recurrences: Recurrence[];
};

type PlannerView = 'project' | 'today' | 'week' | 'recurring';
type MobilePane = 'navigation' | 'plan' | 'assistant';
type TaskAction = 'start' | 'pause' | 'complete' | 'skip';

const LAST_PROJECT_KEY = 'mainworker:planner:last-project';
const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const emptyPayload: PlannerPayload = {
  calendar: { today: '', weekStart: '', weekEnd: '', timeZone: 'Asia/Shanghai' },
  projects: [],
  tasks: [],
  recurrences: [],
};

function shortDate(date: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${date}T12:00:00`));
}

function dateMeta(task: Task, today: string) {
  const labels: string[] = [];
  if (task.plannedDate) labels.push(task.plannedDate < today ? `计划 ${shortDate(task.plannedDate)} · 已逾期` : task.plannedDate === today ? '计划今天' : `计划 ${shortDate(task.plannedDate)}`);
  if (task.deadlineDate) labels.push(task.deadlineDate < today ? `截止 ${shortDate(task.deadlineDate)} · 已逾期` : task.deadlineDate === today ? '今天截止' : `${shortDate(task.deadlineDate)} 截止`);
  return labels;
}

function recurrenceLabel(recurrence: Recurrence) {
  if (recurrence.frequency === 'daily') return '每天';
  if (recurrence.frequency === 'workdays') return '每个工作日';
  return `每周 ${recurrence.weekdays.map((day) => WEEKDAY_LABELS[day]).join('、')}`;
}

function projectStatusLabel(status: Project['status']) {
  return status === 'active' ? '进行中' : status === 'paused' ? '已暂停' : status === 'completed' ? '已完成' : '已归档';
}

function recurrenceStateLabel(state: Recurrence['state']) {
  return state === 'active' ? '启用' : state === 'paused' ? '已暂停' : '已结束';
}

export function PlannerModule({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<PlannerPayload>(emptyPayload);
  const [view, setView] = useState<PlannerView>('project');
  const [mobilePane, setMobilePane] = useState<MobilePane>('plan');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handleError = useCallback((caught: unknown) => {
    if ((caught as { status?: number }).status === 401) onUnauthorized();
    else setError(caught instanceof Error ? caught.message : '操作失败');
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    try {
      setData(await api<PlannerPayload>('/api/planner'));
      setError('');
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const { projects, tasks, recurrences, calendar } = data;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const recurrenceById = useMemo(() => new Map(recurrences.map((recurrence) => [recurrence.id, recurrence])), [recurrences]);
  const childrenByTask = useMemo(() => {
    const grouped = new Map<number, Task[]>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      const children = grouped.get(task.parentId) || [];
      children.push(task);
      grouped.set(task.parentId, children);
    }
    return grouped;
  }, [tasks]);

  useEffect(() => {
    if (!projects.length) {
      if (selectedProjectId !== null) queueMicrotask(() => setSelectedProjectId(null));
      return;
    }
    if (projects.some((project) => project.id === selectedProjectId)) return;
    let stored = 0;
    try { stored = Number(localStorage.getItem(LAST_PROJECT_KEY)); } catch { /* Optional preference. */ }
    const next = projects.find((project) => project.id === stored)
      || projects.find((project) => project.status === 'active') || projects[0];
    queueMicrotask(() => setSelectedProjectId(next.id));
  }, [projects, selectedProjectId]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const selectedProjectTasks = selectedProject
    ? tasks.filter((task) => task.projectId === selectedProject.id && !task.parentId
      && (!task.recurrenceId || ['todo', 'doing'].includes(task.status)))
    : [];
  const selectedProjectRecurrences = selectedProject
    ? recurrences.filter((recurrence) => recurrence.projectId === selectedProject.id)
    : [];

  const progress = useMemo(() => {
    if (!selectedProject) return null;
    const ordinary = tasks.filter((task) => task.projectId === selectedProject.id
      && !task.recurrenceId
      && !(task.parentId && taskById.get(task.parentId)?.recurrenceId));
    const parentIds = new Set(ordinary.filter((task) => task.parentId).map((task) => task.parentId));
    const leaves = ordinary.filter((task) => task.status !== 'canceled' && (task.parentId || !parentIds.has(task.id)));
    if (!leaves.length) return null;
    return { done: leaves.filter((task) => task.status === 'done').length, total: leaves.length };
  }, [selectedProject, taskById, tasks]);

  const isTaskVisibleInExecution = useCallback((task: Task, range: 'today' | 'week') => {
    if (!['todo', 'doing'].includes(task.status)) return false;
    const project = projectById.get(task.projectId);
    if (!project || project.status !== 'active') return false;
    const root = task.parentId ? taskById.get(task.parentId) : task;
    if (root?.recurrenceId) {
      const recurrence = recurrenceById.get(root.recurrenceId);
      if (!recurrence || recurrence.state !== 'active') return false;
    }
    const end = range === 'today' ? calendar.today : calendar.weekEnd;
    return task.status === 'doing'
      || Boolean(task.plannedDate && task.plannedDate <= end)
      || Boolean(task.deadlineDate && task.deadlineDate <= end);
  }, [calendar.today, calendar.weekEnd, projectById, recurrenceById, taskById]);

  const executionTasks = useMemo(() => tasks
    .filter((task) => isTaskVisibleInExecution(task, view === 'today' ? 'today' : 'week'))
    .sort((left, right) => {
      const leftOverdue = Boolean((left.plannedDate && left.plannedDate < calendar.today) || (left.deadlineDate && left.deadlineDate < calendar.today));
      const rightOverdue = Boolean((right.plannedDate && right.plannedDate < calendar.today) || (right.deadlineDate && right.deadlineDate < calendar.today));
      const state = Number(right.status === 'doing') - Number(left.status === 'doing');
      if (state) return state;
      const overdue = Number(rightOverdue) - Number(leftOverdue);
      if (overdue) return overdue;
      const date = (left.plannedDate || left.deadlineDate || '9999-12-31').localeCompare(right.plannedDate || right.deadlineDate || '9999-12-31');
      if (date) return date;
      const priorityRank = { high: 0, medium: 1, low: 2 };
      const priority = priorityRank[left.priority] - priorityRank[right.priority];
      if (priority) return priority;
      const project = (projectById.get(left.projectId)?.position || 0) - (projectById.get(right.projectId)?.position || 0);
      return project || left.position - right.position || left.id - right.id;
    }), [calendar.today, isTaskVisibleInExecution, projectById, tasks, view]);

  const nextTask = selectedProjectTasks.find((task) => task.status === 'doing')
    || selectedProjectTasks.find((task) => task.status === 'todo') || null;

  function selectProject(project: Project) {
    setSelectedProjectId(project.id);
    setView('project');
    setMobilePane('plan');
    try { localStorage.setItem(LAST_PROJECT_KEY, String(project.id)); } catch { /* Optional preference. */ }
  }

  async function runTaskAction(task: Task, action: TaskAction) {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      await api(`/api/planner/tasks/${task.id}/action`, {
        method: 'POST', body: JSON.stringify({ action }),
      });
      await load();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusyTaskId(null);
    }
  }

  function renderTaskActions(task: Task) {
    if (!['todo', 'doing'].includes(task.status)) return <span className={`planner-status is-${task.status}`}>{task.status === 'done' ? '已完成' : task.status === 'skipped' ? '已跳过' : '已取消'}</span>;
    return (
      <div className="planner-task-actions">
        {task.recurrenceId ? <Button variant="ghost" size="sm" disabled={busyTaskId === task.id} onClick={() => void runTaskAction(task, 'skip')}><ChevronRight />跳过本次</Button> : null}
        <Button variant={task.status === 'doing' ? 'secondary' : 'ghost'} size="sm" disabled={busyTaskId === task.id} onClick={() => void runTaskAction(task, task.status === 'doing' ? 'pause' : 'start')}>
          {task.status === 'doing' ? <><Pause />暂停</> : <><Play />开始</>}
        </Button>
      </div>
    );
  }

  function renderTask(task: Task, nested = false) {
    const children = childrenByTask.get(task.id) || [];
    const unresolvedChildren = children.some((child) => ['todo', 'doing'].includes(child.status));
    const resolved = ['done', 'canceled', 'skipped'].includes(task.status);
    const recurrence = task.recurrenceId ? recurrenceById.get(task.recurrenceId) : null;
    return (
      <div className={`planner-task-group ${nested ? 'is-subtask' : ''}`} key={task.id}>
        <article className={`planner-task ${resolved ? 'is-resolved' : ''}`}>
          <Checkbox
            checked={task.status === 'done'}
            disabled={resolved || unresolvedChildren || busyTaskId === task.id}
            onCheckedChange={(checked) => { if (checked) void runTaskAction(task, 'complete'); }}
            aria-label={`完成 ${task.title}`}
            title={unresolvedChildren ? '请先完成或取消所有子任务' : '完成任务'}
          />
          <div className="planner-task-copy">
            <div className="planner-task-title">
              <strong>{task.title}</strong>
              {recurrence ? <span className="planner-kind"><Repeat2 />{recurrenceLabel(recurrence)}</span> : nested ? <span className="planner-kind">子任务</span> : null}
            </div>
            <div className="planner-task-meta">
              {dateMeta(task, calendar.today).map((label) => <span key={label}><CalendarClock />{label}</span>)}
              <span className={`priority ${task.priority}`}><Flag />{task.priority === 'high' ? '高' : task.priority === 'low' ? '低' : '中'}优先级</span>
            </div>
            {task.notes ? <p>{task.notes}</p> : null}
          </div>
          {renderTaskActions(task)}
        </article>
        {children.length ? <div className="planner-subtasks">{children.map((child) => renderTask(child, true))}</div> : null}
      </div>
    );
  }

  function renderExecutionTask(task: Task) {
    const project = projectById.get(task.projectId);
    const parent = task.parentId ? taskById.get(task.parentId) : null;
    return (
      <div className="planner-execution-item" key={task.id}>
        <button type="button" onClick={() => { if (project) selectProject(project); }}>
          {project?.title}{parent ? ` / ${parent.title}` : ''}
        </button>
        {renderTask(task, Boolean(task.parentId))}
      </div>
    );
  }

  function recurrenceStats(recurrence: Recurrence) {
    const instances = tasks.filter((task) => task.recurrenceId === recurrence.id
      && task.occurrenceDate && task.occurrenceDate >= calendar.weekStart
      && task.occurrenceDate <= calendar.today);
    return {
      completed: instances.filter((task) => task.status === 'done').length,
      skipped: instances.filter((task) => task.status === 'skipped').length,
      due: instances.length,
    };
  }

  function renderRecurrence(recurrence: Recurrence) {
    const project = projectById.get(recurrence.projectId);
    const current = recurrence.currentTaskId ? taskById.get(recurrence.currentTaskId) : null;
    const stats = recurrenceStats(recurrence);
    return (
      <article className="planner-recurrence" key={recurrence.id}>
        <span className={`planner-recurrence-icon is-${recurrence.state}`}><Repeat2 /></span>
        <div>
          <header><strong>{recurrence.title}</strong><span className={`planner-status is-${recurrence.state}`}>{recurrenceStateLabel(recurrence.state)}</span></header>
          <p>{project?.title} · {recurrenceLabel(recurrence)}</p>
          <div className="planner-recurrence-meta">
            <span>开始 {shortDate(recurrence.startDate)}</span>
            {recurrence.endDate ? <span>结束 {shortDate(recurrence.endDate)}</span> : <span>长期循环</span>}
            {current ? <span>当前实例 {shortDate(current.occurrenceDate || current.plannedDate || calendar.today)}</span> : <span>没有当前实例</span>}
          </div>
          {recurrence.subtasks.length ? <small>{recurrence.subtasks.length} 项子任务模板：{recurrence.subtasks.map((item) => item.title).join('、')}</small> : null}
        </div>
        <div className="planner-recurrence-stats"><strong>{stats.completed}/{stats.due}</strong><span>本周完成</span>{stats.skipped ? <small>{stats.skipped} 次跳过</small> : null}</div>
      </article>
    );
  }

  return (
    <section className={`planner-module mobile-pane-${mobilePane}`}>
      <header className="planner-topbar">
        <div><p className="overline">TASK PLANNER</p><h1>任务规划</h1><p>项目、任务与循环执行</p></div>
        <div className="planner-topbar-actions">
          <span className="planner-ai-managed"><Bot />AI 维护内容</span>
          <span className="planner-date"><CalendarCheck />{calendar.today ? `${shortDate(calendar.today)} ${WEEKDAY_LABELS[new Date(`${calendar.today}T00:00:00Z`).getUTCDay() || 7]}` : '读取日期中'}</span>
        </div>
      </header>

      <nav className="planner-mobile-nav" aria-label="任务规划工作区">
        <Button variant={mobilePane === 'navigation' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('navigation')}><FolderKanban />项目</Button>
        <Button variant={mobilePane === 'plan' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('plan')}><ListChecks />计划</Button>
        <Button variant={mobilePane === 'assistant' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMobilePane('assistant')}><MessageSquareText />AI 助手</Button>
      </nav>

      <div className="planner-shell">
        <aside className="planner-sidebar">
          <section>
            <p>执行</p>
            <button type="button" className={view === 'today' ? 'is-active' : ''} onClick={() => { setView('today'); setMobilePane('plan'); }}><CalendarCheck /><span>今日</span><small>{tasks.filter((task) => isTaskVisibleInExecution(task, 'today')).length}</small></button>
            <button type="button" className={view === 'week' ? 'is-active' : ''} onClick={() => { setView('week'); setMobilePane('plan'); }}><CalendarDays /><span>本周</span><small>{tasks.filter((task) => isTaskVisibleInExecution(task, 'week')).length}</small></button>
            <button type="button" className={view === 'recurring' ? 'is-active' : ''} onClick={() => { setView('recurring'); setMobilePane('plan'); }}><Repeat2 /><span>循环任务</span><small>{recurrences.filter((item) => item.state !== 'ended').length}</small></button>
          </section>
          <section>
            <p>项目</p>
            {projects.map((project) => {
              const open = tasks.filter((task) => task.projectId === project.id && !task.parentId && ['todo', 'doing'].includes(task.status)).length;
              return <button type="button" className={view === 'project' && selectedProjectId === project.id ? 'is-active' : ''} onClick={() => selectProject(project)} key={project.id}><FolderKanban /><span>{project.title}</span><small>{open}</small><ChevronRight /></button>;
            })}
          </section>
          {!loading && !projects.length ? <div className="planner-sidebar-empty">让 AI 助手创建第一个项目</div> : null}
        </aside>

        <main className="planner-detail">
          {error ? <div className="planner-error" role="alert">{error}</div> : null}
          {loading ? <div className="planner-empty"><LoaderCircle className="spin" /><p>正在读取规划…</p></div> : null}

          {!loading && view === 'project' && selectedProject ? (
            <>
              <header className="planner-project-head">
                <div><span>项目</span><h2>{selectedProject.title}</h2><p>{selectedProject.notes || '还没有项目说明，可以让右侧 AI 补充目标或完成标准。'}</p></div>
                <span className={`planner-status is-${selectedProject.status}`}>{projectStatusLabel(selectedProject.status)}</span>
              </header>

              {progress ? <div className="planner-progress"><div><span style={{ width: `${progress.done / progress.total * 100}%` }} /></div><p>{progress.done} / {progress.total} 普通任务已完成</p></div> : <div className="planner-progress-note">这个项目暂时没有可计算的普通任务进度</div>}

              <section className="planner-next-action">
                <div><Sparkles /><span><small>{nextTask?.status === 'doing' ? '正在推进' : '建议下一步'}</small><strong>{nextTask?.title || '让 AI 拆出第一项可执行任务'}</strong><p>{nextTask ? dateMeta(nextTask, calendar.today)[0] || '尚未安排日期' : '在右侧描述目标，AI 会维护项目任务。'}</p></span></div>
                {nextTask && nextTask.status !== 'doing' ? <Button size="sm" onClick={() => void runTaskAction(nextTask, 'start')}><Play />开始</Button> : null}
              </section>

              <section className="planner-tasks-section">
                <header><div><h3>任务</h3><p>{selectedProjectTasks.length} 项顶层任务 · 内容由 AI 维护</p></div></header>
                {selectedProjectTasks.length ? <div className="planner-task-list">{selectedProjectTasks.map((task) => renderTask(task))}</div> : <div className="planner-empty is-compact"><ListChecks /><p>这个项目还没有任务，可以让 AI 帮你拆解</p></div>}
              </section>

              {selectedProjectRecurrences.length ? <section className="planner-tasks-section"><header><div><h3>循环任务</h3><p>永久进度之外单独统计</p></div></header><div className="planner-recurrence-list">{selectedProjectRecurrences.map(renderRecurrence)}</div></section> : null}
            </>
          ) : null}

          {!loading && view === 'project' && !selectedProject ? <div className="planner-empty"><FolderKanban /><h3>从一个项目开始</h3><p>在右侧告诉 AI 你准备推进什么。</p></div> : null}

          {!loading && (view === 'today' || view === 'week') ? (
            <section className="planner-execution-view">
              <header><span>执行视图</span><h2>{view === 'today' ? '今日' : '本周'}</h2><p>{view === 'today' ? `计划日期不晚于 ${calendar.today}、今日截止或正在进行的任务。` : `${calendar.weekStart} 至 ${calendar.weekEnd}，同时包含尚未解决的逾期任务。`}</p></header>
              {executionTasks.length ? <div className="planner-execution-list">{executionTasks.map(renderExecutionTask)}</div> : <div className="planner-empty"><Check /><h3>{view === 'today' ? '今天没有待执行任务' : '本周没有待执行任务'}</h3><p>可以让右侧 AI 安排计划日期。</p></div>}
            </section>
          ) : null}

          {!loading && view === 'recurring' ? (
            <section className="planner-execution-view">
              <header><span>固定日历循环</span><h2>循环任务</h2><p>每条规则始终最多保留一个未解决实例；完成或跳过本次后才生成下一次。</p></header>
              {recurrences.length ? <div className="planner-recurrence-list is-management">{recurrences.map(renderRecurrence)}</div> : <div className="planner-empty"><Repeat2 /><h3>还没有循环任务</h3><p>可以让 AI 创建每天、工作日或每周指定星期的循环。</p></div>}
            </section>
          ) : null}
        </main>

        <aside className="planner-assistant">
          <ChatWorkspace compact scope="planner" contextId="all" title="规划助手" subtitle="负责项目、任务与循环规则" onUnauthorized={onUnauthorized} onRunComplete={() => void load()} />
        </aside>
      </div>
    </section>
  );
}
