const TIME_ZONE = 'Asia/Shanghai';
const PROJECT_STATUSES = new Set(['active', 'paused', 'completed', 'archived']);
const PRIORITIES = new Set(['low', 'medium', 'high']);
const FREQUENCIES = new Set(['daily', 'workdays', 'weekly']);
const OPEN_TASK_STATUSES = new Set(['todo', 'doing']);

export const PLANNER_DYNAMIC_TOOLS = [{
  type: 'function',
  name: 'manage_personal_plan',
  description: [
    'Manage projects, tasks, one-level subtasks, and daily or weekly recurring tasks in the owner\'s personal planner.',
    'Use this tool for every requested plan change. The UI only handles execution actions.',
    'Never delete data, end a recurrence, or make a structurally ambiguous change unless the user explicitly requested it.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'create_project', 'update_project', 'delete_project',
          'create_task', 'update_task', 'delete_task', 'act_on_task',
          'create_recurring_task', 'update_recurring_task', 'pause_recurring_task',
          'resume_recurring_task', 'end_recurring_task', 'delete_recurring_task',
        ],
      },
      id: { type: 'integer', minimum: 1, description: 'Target project, task, or recurrence ID.' },
      projectId: { type: 'integer', minimum: 1 },
      parentTaskId: { type: ['integer', 'null'], minimum: 1, description: 'Parent task ID for a subtask; null makes a top-level task.' },
      title: { type: 'string', minLength: 1, maxLength: 240 },
      notes: { type: 'string', maxLength: 4000 },
      projectStatus: { type: 'string', enum: ['active', 'paused', 'completed', 'archived'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      plannedDate: { type: ['string', 'null'], description: 'Planned execution date in YYYY-MM-DD format.' },
      deadlineDate: { type: ['string', 'null'], description: 'Deadline in YYYY-MM-DD format.' },
      position: { type: 'integer', minimum: 0 },
      taskAction: { type: 'string', enum: ['start', 'pause', 'complete', 'cancel', 'skip'] },
      frequency: { type: 'string', enum: ['daily', 'workdays', 'weekly'] },
      weekdays: {
        type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, uniqueItems: true,
        description: 'Required for weekly recurrence. Monday is 1 and Sunday is 7.',
      },
      startDate: { type: 'string', description: 'Required recurrence start date in YYYY-MM-DD format.' },
      endDate: { type: ['string', 'null'], description: 'Optional recurrence end date in YYYY-MM-DD format.' },
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 240 },
            notes: { type: 'string', maxLength: 4000 },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['title'],
          additionalProperties: false,
        },
        description: 'Recurring subtask template. Replacing it only affects future occurrences.',
      },
      resumePolicy: { type: 'string', enum: ['keep', 'skip'], description: 'Required when resuming an overdue current occurrence.' },
      endPolicy: { type: 'string', enum: ['complete', 'skip'], description: 'Required when ending a recurrence with an open occurrence.' },
    },
    required: ['operation'],
    additionalProperties: false,
  },
}];

function stringField(input, key, maximum, required = false) {
  if (!Object.hasOwn(input, key)) {
    if (required) throw new Error(`缺少${key === 'title' ? '标题' : '文本内容'}`);
    return undefined;
  }
  const value = String(input[key] || '').trim();
  if ((required && !value) || value.length > maximum) throw new Error(`${key === 'title' ? '标题' : '说明'}格式无效`);
  return value;
}

function positiveId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}编号无效`);
  return number;
}

function optionalPosition(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('顺序必须是非负整数');
  return number;
}

export function validPlannerDate(value) {
  if (value == null || value === '') return true;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function requiredDate(value, label) {
  if (!value || !validPlannerDate(value)) throw new Error(`${label}必须为 YYYY-MM-DD 格式`);
  return String(value);
}

function optionalDate(input, key, label) {
  if (!Object.hasOwn(input, key)) return undefined;
  if (!validPlannerDate(input[key])) throw new Error(`${label}必须为 YYYY-MM-DD 格式`);
  return input[key] ? String(input[key]) : null;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function plannerCalendar(now = new Date()) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(now);
  const day = weekday(today);
  return { today, weekStart: addDays(today, 1 - day), weekEnd: addDays(today, 7 - day), timeZone: TIME_ZONE };
}

function parseWeekdays(value) {
  try {
    const values = JSON.parse(value || '[]');
    return Array.isArray(values) ? values.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7) : [];
  } catch {
    return [];
  }
}

function normalizeWeekdays(frequency, value) {
  if (frequency !== 'weekly') return [];
  if (!Array.isArray(value)) throw new Error('每周循环必须指定星期');
  const days = [...new Set(value.map(Number))].sort((left, right) => left - right);
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('每周循环的星期无效');
  return days;
}

function recurrenceMatches(frequency, weekdays, date) {
  const day = weekday(date);
  if (frequency === 'daily') return true;
  if (frequency === 'workdays') return day <= 5;
  return weekdays.includes(day);
}

export function nextRecurrenceDate(recurrence, afterDate, inclusive = false) {
  const weekdays = Array.isArray(recurrence.weekdays) ? recurrence.weekdays : parseWeekdays(recurrence.weekdays_json);
  let candidate = inclusive ? afterDate : addDays(afterDate, 1);
  if (candidate < recurrence.start_date) candidate = recurrence.start_date;
  for (let index = 0; index < 370; index += 1) {
    if (recurrence.end_date && candidate > recurrence.end_date) return null;
    if (recurrenceMatches(recurrence.frequency, weekdays, candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error('无法计算下一次循环日期');
}

function publicProject(project) {
  return {
    id: Number(project.id), title: project.title, notes: project.notes, status: project.status,
    position: Number(project.position), createdAt: project.created_at, updatedAt: project.updated_at,
  };
}

function publicTask(task) {
  return {
    id: Number(task.id), projectId: Number(task.project_id), parentId: task.parent_id ? Number(task.parent_id) : null,
    title: task.title, notes: task.notes, status: task.status, priority: task.priority,
    plannedDate: task.planned_date, deadlineDate: task.deadline_date, position: Number(task.position),
    recurrenceId: task.recurrence_id ? Number(task.recurrence_id) : null,
    occurrenceDate: task.occurrence_date, completedAt: task.completed_at,
    createdAt: task.created_at, updatedAt: task.updated_at,
  };
}

function publicRecurrence(recurrence, subtasks, currentTask) {
  return {
    id: Number(recurrence.id), projectId: Number(recurrence.project_id), title: recurrence.title,
    notes: recurrence.notes, priority: recurrence.priority, frequency: recurrence.frequency,
    weekdays: parseWeekdays(recurrence.weekdays_json), startDate: recurrence.start_date,
    endDate: recurrence.end_date, state: recurrence.state, position: Number(recurrence.position),
    currentTaskId: currentTask ? Number(currentTask.id) : null,
    subtasks: subtasks.map((task) => ({
      id: Number(task.id), title: task.title, notes: task.notes,
      priority: task.priority, position: Number(task.position),
    })),
    createdAt: recurrence.created_at, updatedAt: recurrence.updated_at,
  };
}

function toolResult(message, value = {}) {
  return { message, ...value };
}

export class PlannerService {
  constructor(database) {
    this.database = database;
  }

  snapshot() {
    const projects = this.database.listProjects();
    const tasks = this.database.listTasks();
    const recurrences = this.database.listRecurrences();
    return {
      calendar: plannerCalendar(),
      projects: projects.map(publicProject),
      tasks: tasks.map(publicTask),
      recurrences: recurrences.map((recurrence) => publicRecurrence(
        recurrence,
        this.database.listRecurrenceSubtasks(Number(recurrence.id)),
        this.database.getOpenRecurrenceTask(Number(recurrence.id)),
      )),
    };
  }

  #project(id) {
    const project = this.database.getProject(positiveId(id, '项目'));
    if (!project) throw new Error('项目不存在');
    return project;
  }

  #task(id) {
    const task = this.database.getTask(positiveId(id, '任务'));
    if (!task) throw new Error('任务不存在');
    return task;
  }

  #recurrence(id) {
    const recurrence = this.database.getRecurrence(positiveId(id, '循环任务'));
    if (!recurrence) throw new Error('循环任务不存在');
    return recurrence;
  }

  #assertProjectAcceptsTasks(project) {
    if (['completed', 'archived'].includes(project.status)) {
      throw new Error('已完成或已归档的项目不能新增或移入任务，请先恢复项目状态');
    }
  }

  #recurrenceRoot(task) {
    if (task.recurrence_id) return task;
    if (!task.parent_id) return null;
    const parent = this.database.getTask(Number(task.parent_id));
    return parent?.recurrence_id ? parent : null;
  }

  #assertMutableTask(task) {
    const recurrenceRoot = this.#recurrenceRoot(task);
    if (recurrenceRoot && !OPEN_TASK_STATUSES.has(recurrenceRoot.status)) {
      throw new Error('循环任务的历史实例不可修改');
    }
  }

  #validateProjectResolution(projectId, status) {
    if (!['completed', 'archived'].includes(status)) return;
    const projectTasks = this.database.listProjectTasks(projectId);
    const recurrenceRootIds = new Set(projectTasks.filter((task) => task.recurrence_id).map((task) => Number(task.id)));
    const openTasks = projectTasks.filter((task) => !task.recurrence_id
      && !(task.parent_id && recurrenceRootIds.has(Number(task.parent_id)))
      && OPEN_TASK_STATUSES.has(task.status));
    if (openTasks.length) throw new Error('项目仍有未解决的普通任务，不能完成或归档');
    const openRecurrences = this.database.listRecurrences().filter((recurrence) => Number(recurrence.project_id) === projectId && recurrence.state !== 'ended');
    if (openRecurrences.length) throw new Error('项目仍有未结束的循环任务，不能完成或归档');
  }

  #taskInput(input, { titleRequired = false } = {}) {
    const priority = input.priority === undefined ? undefined : String(input.priority);
    if (priority !== undefined && !PRIORITIES.has(priority)) throw new Error('优先级无效');
    return {
      title: stringField(input, 'title', 240, titleRequired),
      notes: stringField(input, 'notes', 4000),
      priority,
      plannedDate: optionalDate(input, 'plannedDate', '计划日期'),
      deadlineDate: optionalDate(input, 'deadlineDate', '截止日期'),
      position: optionalPosition(input.position),
    };
  }

  #recurrenceInput(input, current = null) {
    const frequency = input.frequency === undefined ? current?.frequency : String(input.frequency);
    if (!FREQUENCIES.has(frequency)) throw new Error('循环频率无效');
    const weekdays = normalizeWeekdays(frequency, input.weekdays === undefined && current ? parseWeekdays(current.weekdays_json) : input.weekdays);
    const startDate = input.startDate === undefined ? current?.start_date : requiredDate(input.startDate, '开始日期');
    if (!startDate) throw new Error('缺少循环开始日期');
    const endDate = input.endDate === undefined ? current?.end_date || null : optionalDate(input, 'endDate', '结束日期');
    if (endDate && endDate < startDate) throw new Error('循环结束日期不能早于开始日期');
    const task = this.#taskInput(input, { titleRequired: !current });
    return { ...task, frequency, weekdays, startDate, endDate };
  }

  #subtaskTemplates(value) {
    if (!Array.isArray(value)) throw new Error('循环子任务模板无效');
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('循环子任务模板无效');
      const priority = entry.priority === undefined ? 'medium' : String(entry.priority);
      if (!PRIORITIES.has(priority)) throw new Error('循环子任务优先级无效');
      return { title: stringField(entry, 'title', 240, true), notes: stringField(entry, 'notes', 4000) || '', priority };
    });
  }

  actOnTask(idValue, actionValue) {
    const task = this.#task(idValue);
    const action = String(actionValue || '');
    if (!['start', 'pause', 'complete', 'cancel', 'skip'].includes(action)) throw new Error('任务操作无效');
    if (['done', 'canceled', 'skipped'].includes(task.status)) throw new Error('任务已经解决，不能再次操作');
    if (action === 'start') {
      if (task.status !== 'todo') throw new Error('只有待办任务可以开始');
      return publicTask(this.database.updateTask(Number(task.id), { status: 'doing' }));
    }
    if (action === 'pause') {
      if (task.status !== 'doing') throw new Error('只有进行中的任务可以暂停');
      return publicTask(this.database.updateTask(Number(task.id), { status: 'todo' }));
    }

    const taskId = Number(task.id);
    const children = this.database.listTaskChildren(taskId);
    if (action === 'complete' && children.some((child) => OPEN_TASK_STATUSES.has(child.status))) {
      throw new Error('仍有未完成的子任务，不能完成父任务');
    }
    if (action === 'skip' && !task.recurrence_id) throw new Error('只有循环任务当前实例可以跳过');
    if (action === 'cancel' && task.recurrence_id) throw new Error('循环任务请使用“跳过本次”或“结束循环”');

    const resolution = action === 'complete' ? 'done' : action === 'skip' ? 'skipped' : 'canceled';
    const completedAt = action === 'complete' ? new Date().toISOString() : null;
    if (!task.recurrence_id) {
      return this.database.transaction(() => {
        if (resolution === 'canceled') {
          for (const child of children) if (OPEN_TASK_STATUSES.has(child.status)) this.database.updateTask(Number(child.id), { status: 'canceled' });
        }
        return publicTask(this.database.updateTask(taskId, { status: resolution, completedAt }));
      });
    }

    const recurrence = this.#recurrence(Number(task.recurrence_id));
    const calendar = plannerCalendar();
    const recurrenceReferenceDate = task.occurrence_date > calendar.today ? task.occurrence_date : calendar.today;
    const followingDate = nextRecurrenceDate(recurrence, recurrenceReferenceDate);
    const nextDate = recurrence.state === 'active' ? followingDate : null;
    return this.database.transaction(() => {
      if (resolution === 'skipped') {
        for (const child of children) if (OPEN_TASK_STATUSES.has(child.status)) this.database.updateTask(Number(child.id), { status: 'skipped' });
      }
      const resolved = this.database.updateTask(taskId, { status: resolution, completedAt });
      if (nextDate) this.database.insertRecurrenceOccurrence(Number(recurrence.id), nextDate);
      else if (recurrence.end_date && !followingDate) {
        this.database.updateRecurrence(Number(recurrence.id), { state: 'ended' });
      }
      return publicTask(resolved);
    });
  }

  execute(argumentsValue) {
    const input = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('规划工具参数无效');
    const operation = String(input.operation || '');

    if (operation === 'create_project') {
      const project = this.database.createProject({
        title: stringField(input, 'title', 240, true), notes: stringField(input, 'notes', 4000) || '',
        status: 'active', position: optionalPosition(input.position),
      });
      return toolResult('项目已创建', { project: publicProject(project) });
    }
    if (operation === 'update_project') {
      const project = this.#project(input.id);
      const status = input.projectStatus === undefined ? undefined : String(input.projectStatus);
      if (status !== undefined && !PROJECT_STATUSES.has(status)) throw new Error('项目状态无效');
      if (status) this.#validateProjectResolution(Number(project.id), status);
      const changes = {
        title: stringField(input, 'title', 240), notes: stringField(input, 'notes', 4000),
        status, position: optionalPosition(input.position),
      };
      if (Object.values(changes).every((value) => value === undefined)) throw new Error('没有需要更新的项目内容');
      return toolResult('项目已更新', { project: publicProject(this.database.updateProject(Number(project.id), changes)) });
    }
    if (operation === 'delete_project') {
      const project = this.#project(input.id);
      this.database.deleteProject(Number(project.id));
      return toolResult('项目及其任务已删除', { deletedProjectId: Number(project.id) });
    }
    if (operation === 'create_task') {
      const project = this.#project(input.projectId);
      this.#assertProjectAcceptsTasks(project);
      const parent = input.parentTaskId == null ? null : this.#task(input.parentTaskId);
      if (parent && (parent.parent_id || Number(parent.project_id) !== Number(project.id))) throw new Error('子任务只能属于同项目的顶层任务');
      if (parent && !OPEN_TASK_STATUSES.has(parent.status)) throw new Error('已解决的任务不能新增子任务');
      const task = this.database.createTask({
        ...this.#taskInput(input, { titleRequired: true }), projectId: Number(project.id),
        parentId: parent ? Number(parent.id) : null,
      });
      return toolResult(parent ? '子任务已创建' : '任务已创建', { task: publicTask(task) });
    }
    if (operation === 'update_task') {
      const task = this.#task(input.id);
      this.#assertMutableTask(task);
      const project = input.projectId === undefined ? this.#project(Number(task.project_id)) : this.#project(input.projectId);
      if (Number(project.id) !== Number(task.project_id)) this.#assertProjectAcceptsTasks(project);
      let parentId = task.parent_id ? Number(task.parent_id) : null;
      if (Object.hasOwn(input, 'parentTaskId')) {
        if (input.parentTaskId == null) parentId = null;
        else {
          const parent = this.#task(input.parentTaskId);
          if (parent.parent_id || Number(parent.project_id) !== Number(project.id) || Number(parent.id) === Number(task.id)) throw new Error('父任务层级或项目无效');
          if (!OPEN_TASK_STATUSES.has(parent.status)) throw new Error('已解决的任务不能接收子任务');
          parentId = Number(parent.id);
        }
      }
      if (task.recurrence_id) {
        const recurrence = this.#recurrence(Number(task.recurrence_id));
        if (parentId || Number(project.id) !== Number(recurrence.project_id)) throw new Error('循环任务当前实例必须留在循环规则所属项目的顶层');
      }
      if (parentId) {
        const parent = this.#task(parentId);
        if (Number(parent.project_id) !== Number(project.id)) throw new Error('子任务必须与父任务属于同一项目');
      }
      const changes = { ...this.#taskInput(input), projectId: Number(project.id), parentId };
      const changedFields = Object.entries(changes).filter(([key, value]) => !['projectId', 'parentId'].includes(key) && value !== undefined);
      const relationshipChanged = Number(project.id) !== Number(task.project_id) || parentId !== (task.parent_id ? Number(task.parent_id) : null);
      if (!relationshipChanged && !changedFields.length) throw new Error('没有需要更新的任务内容');
      const children = this.database.listTaskChildren(Number(task.id));
      return this.database.transaction(() => {
        if (relationshipChanged && children.length && parentId) throw new Error('包含子任务的任务不能再成为子任务');
        if (Number(project.id) !== Number(task.project_id)) {
          for (const child of children) this.database.updateTask(Number(child.id), { projectId: Number(project.id) });
        }
        return toolResult(task.parent_id ? '子任务已更新' : '任务已更新', { task: publicTask(this.database.updateTask(Number(task.id), changes)) });
      });
    }
    if (operation === 'delete_task') {
      const task = this.#task(input.id);
      this.#assertMutableTask(task);
      if (task.recurrence_id) throw new Error('循环实例不能单独删除，请结束或删除循环任务');
      this.database.deleteTask(Number(task.id));
      return toolResult(task.parent_id ? '子任务已删除' : '任务及其子任务已删除', { deletedTaskId: Number(task.id) });
    }
    if (operation === 'act_on_task') {
      return toolResult('任务状态已更新', { task: this.actOnTask(input.id, input.taskAction) });
    }
    if (operation === 'create_recurring_task') {
      const project = this.#project(input.projectId);
      this.#assertProjectAcceptsTasks(project);
      const recurrence = this.#recurrenceInput(input);
      const subtasks = input.subtasks === undefined ? [] : this.#subtaskTemplates(input.subtasks);
      const calendar = plannerCalendar();
      const firstDate = nextRecurrenceDate({
        frequency: recurrence.frequency, weekdays: recurrence.weekdays,
        start_date: recurrence.startDate, end_date: recurrence.endDate,
      }, recurrence.startDate > calendar.today ? recurrence.startDate : calendar.today, true);
      if (!firstDate) throw new Error('循环结束日期已经过去，无法创建当前实例');
      const created = this.database.createRecurrence({
        ...recurrence, projectId: Number(project.id), subtasks,
      }, firstDate);
      return toolResult('循环任务已创建', { recurrence: publicRecurrence(created, this.database.listRecurrenceSubtasks(Number(created.id)), this.database.getOpenRecurrenceTask(Number(created.id))) });
    }
    if (operation === 'update_recurring_task') {
      const current = this.#recurrence(input.id);
      if (current.state === 'ended') throw new Error('已结束的循环任务不能再修改');
      const project = input.projectId === undefined ? this.#project(Number(current.project_id)) : this.#project(input.projectId);
      const projectChanged = Number(project.id) !== Number(current.project_id);
      if (projectChanged) this.#assertProjectAcceptsTasks(project);
      const changes = { ...this.#recurrenceInput(input, current), projectId: Number(project.id), position: optionalPosition(input.position) };
      const hasTemplateChange = input.subtasks !== undefined;
      const providedKeys = ['title', 'notes', 'priority', 'frequency', 'weekdays', 'startDate', 'endDate', 'projectId', 'position'];
      if (!hasTemplateChange && !providedKeys.some((key) => Object.hasOwn(input, key))) throw new Error('没有需要更新的循环任务内容');
      const updated = this.database.transaction(() => {
        const value = this.database.updateRecurrence(Number(current.id), changes);
        if (projectChanged) {
          const occurrence = this.database.getOpenRecurrenceTask(Number(current.id));
          if (occurrence) {
            this.database.updateTask(Number(occurrence.id), { projectId: Number(project.id) });
            for (const child of this.database.listTaskChildren(Number(occurrence.id))) {
              this.database.updateTask(Number(child.id), { projectId: Number(project.id) });
            }
          }
        }
        if (hasTemplateChange) this.database.replaceRecurrenceSubtasks(Number(current.id), this.#subtaskTemplates(input.subtasks));
        return value;
      });
      return toolResult('循环任务模板已更新，当前实例保持不变', { recurrence: publicRecurrence(updated, this.database.listRecurrenceSubtasks(Number(updated.id)), this.database.getOpenRecurrenceTask(Number(updated.id))) });
    }
    if (operation === 'pause_recurring_task') {
      const recurrence = this.#recurrence(input.id);
      if (recurrence.state !== 'active') throw new Error('只有启用中的循环任务可以暂停');
      return toolResult('循环任务已暂停，当前实例已保留', { recurrence: publicRecurrence(this.database.updateRecurrence(Number(recurrence.id), { state: 'paused' }), this.database.listRecurrenceSubtasks(Number(recurrence.id)), this.database.getOpenRecurrenceTask(Number(recurrence.id))) });
    }
    if (operation === 'resume_recurring_task') {
      const recurrence = this.#recurrence(input.id);
      if (recurrence.state !== 'paused') throw new Error('只有暂停的循环任务可以恢复');
      const current = this.database.getOpenRecurrenceTask(Number(recurrence.id));
      const calendar = plannerCalendar();
      if (current?.planned_date < calendar.today && !['keep', 'skip'].includes(input.resumePolicy)) throw new Error('当前实例已经逾期，必须选择保留或跳过');
      const shouldSkip = Boolean(current && current.planned_date < calendar.today && input.resumePolicy === 'skip');
      const latest = current ? null : this.database.getLatestRecurrenceTask(Number(recurrence.id));
      const resumeReferenceDate = latest?.occurrence_date > calendar.today ? latest.occurrence_date : calendar.today;
      const nextDate = (!current || shouldSkip) ? nextRecurrenceDate(recurrence, resumeReferenceDate) : null;
      if ((!current || shouldSkip) && !nextDate) throw new Error('循环已经超过结束日期，不能恢复；请结束循环');
      const updated = this.database.transaction(() => {
        if (current && shouldSkip) {
          for (const child of this.database.listTaskChildren(Number(current.id))) if (OPEN_TASK_STATUSES.has(child.status)) this.database.updateTask(Number(child.id), { status: 'skipped' });
          this.database.updateTask(Number(current.id), { status: 'skipped' });
        }
        const value = this.database.updateRecurrence(Number(recurrence.id), { state: 'active' });
        if (nextDate) this.database.insertRecurrenceOccurrence(Number(recurrence.id), nextDate);
        return value;
      });
      return toolResult('循环任务已恢复', { recurrence: publicRecurrence(updated, this.database.listRecurrenceSubtasks(Number(updated.id)), this.database.getOpenRecurrenceTask(Number(updated.id))) });
    }
    if (operation === 'end_recurring_task') {
      const recurrence = this.#recurrence(input.id);
      if (recurrence.state === 'ended') throw new Error('循环任务已经结束');
      const current = this.database.getOpenRecurrenceTask(Number(recurrence.id));
      if (current && !['complete', 'skip'].includes(input.endPolicy)) throw new Error('必须选择完成本次并结束，或跳过本次并结束');
      if (current && input.endPolicy === 'complete' && this.database.listTaskChildren(Number(current.id)).some((child) => OPEN_TASK_STATUSES.has(child.status))) {
        throw new Error('当前实例仍有未完成子任务，不能按完成方式结束');
      }
      const updated = this.database.transaction(() => {
        if (current) {
          const status = input.endPolicy === 'complete' ? 'done' : 'skipped';
          if (status === 'skipped') {
            for (const child of this.database.listTaskChildren(Number(current.id))) if (OPEN_TASK_STATUSES.has(child.status)) this.database.updateTask(Number(child.id), { status: 'skipped' });
          }
          this.database.updateTask(Number(current.id), { status, completedAt: status === 'done' ? new Date().toISOString() : null });
        }
        return this.database.updateRecurrence(Number(recurrence.id), { state: 'ended' });
      });
      return toolResult('循环任务已结束，历史记录已保留', { recurrence: publicRecurrence(updated, this.database.listRecurrenceSubtasks(Number(updated.id)), null) });
    }
    if (operation === 'delete_recurring_task') {
      const recurrence = this.#recurrence(input.id);
      this.database.deleteRecurrence(Number(recurrence.id));
      return toolResult('循环任务及其历史实例已删除', { deletedRecurrenceId: Number(recurrence.id) });
    }
    throw new Error('不支持的规划操作');
  }
}

export function plannerToolResponse(success, payload) {
  return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(payload) }] };
}
