const DEFAULT_CRON_EXPRESSION = '0 9 * * *';
export const DEFAULT_SCHEDULE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const CRON_FIELD_COUNTS = new Set([5, 6, 7]);
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z0-9._+-]+\/[A-Za-z0-9._+\/-]+)$/;
const SIMPLE_CRON_PATTERN = /^(\d{1,2}) (\d{1,2}) (\*|(?:[1-9]|[12]\d|3[01])) \* (\*|[0-6](?:,[0-6])*)$/;

function invoke(command, args = {}) {
  return window.__TAURI__.core.invoke(command, args).catch(error => {
    throw new Error(typeof error === 'string' ? error : error?.message || '定时计划请求失败');
  });
}

export const workflowScheduleApi = Object.freeze({
  get: workflowId => invoke('workflow_schedule_get', { workflowId }),
  upsert: input => invoke('workflow_schedule_upsert', { input }),
  setEnabled: (workflowId, enabled) => invoke('workflow_schedule_set_enabled', { input: { workflowId, enabled } }),
  delete: workflowId => invoke('workflow_schedule_delete', { workflowId }),
});

export function validateScheduleInput(input) {
  const workflowId = String(input?.workflowId || '').trim();
  const cronExpression = String(input?.cronExpression || '').trim().replace(/\s+/g, ' ');
  const timezone = String(input?.timezone || '').trim();
  if (!workflowId) throw new Error('请先保存并发布流水线');
  if (!CRON_FIELD_COUNTS.has(cronExpression.split(' ').filter(Boolean).length)) {
    throw new Error('Cron 表达式需要 5、6 或 7 个字段');
  }
  if (!TIMEZONE_PATTERN.test(timezone)) throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai');
  return Object.freeze({ workflowId, cronExpression, timezone, enabled: Boolean(input?.enabled) });
}

export function normalizeSchedule(value) {
  if (value == null) return null;
  const schedule = {
    id: String(value.id || ''), workflowId: String(value.workflowId || ''),
    workflowVersionId: String(value.workflowVersionId || ''),
    cronExpression: String(value.cronExpression || ''), timezone: String(value.timezone || ''),
    enabled: Boolean(value.enabled), nextRunAt: value.nextRunAt || null,
    lastScheduledAt: value.lastScheduledAt || null, lastMissedAt: value.lastMissedAt || null,
    lastExecutionStatus: value.lastExecutionStatus || null,
    createdAt: value.createdAt || null, updatedAt: value.updatedAt || null,
  };
  if (!schedule.id || !schedule.workflowId || !schedule.cronExpression || !schedule.timezone) {
    throw new Error('定时计划响应缺少必要字段');
  }
  return Object.freeze(schedule);
}

export function formatScheduleTime(value, timezone) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('定时计划返回了无效时间');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function scheduleStatusLabel(status) {
  const labels = Object.freeze({
    pending: '排队中', running: '执行中', dispatching: '推送中', succeeded: '成功',
    failed: '失败', interrupted: '已中断', cancelled: '已取消',
  });
  return status ? labels[status] || status : '暂无执行';
}

export function parseScheduleExpression(expression) {
  const cronExpression = String(expression || '').trim().replace(/\s+/g, ' ');
  const match = SIMPLE_CRON_PATTERN.exec(cronExpression);
  if (!match) return Object.freeze({ mode: 'custom', cronExpression });
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return Object.freeze({ mode: 'custom', cronExpression });
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (match[3] !== '*' && match[4] === '*') return Object.freeze({ mode: 'monthly', time, monthDay: Number(match[3]), weekdays: [] });
  if (match[3] === '*' && match[4] === '*') return Object.freeze({ mode: 'daily', time, weekdays: [] });
  if (match[3] === '*') return Object.freeze({ mode: 'weekly', time, weekdays: match[4].split(',') });
  return Object.freeze({ mode: 'custom', cronExpression });
}

export function buildScheduleExpression({ mode, time, weekdays = [], monthDay, cronExpression = '' }) {
  if (mode === 'custom') return String(cronExpression).trim().replace(/\s+/g, ' ');
  const match = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('请选择有效的执行时间');
  if (mode === 'daily') return `${Number(match[2])} ${Number(match[1])} * * *`;
  if (mode === 'monthly') {
    const day = Number(monthDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('请选择每月执行日期');
    return `${Number(match[2])} ${Number(match[1])} ${day} * *`;
  }
  const days = [...new Set(weekdays.map(String))].filter(day => /^[0-6]$/.test(day));
  if (mode !== 'weekly' || !days.length) throw new Error('请至少选择一个执行日期');
  return `${Number(match[2])} ${Number(match[1])} * * ${days.join(',')}`;
}

export function bindWorkflowSchedule({ get, toast, onChanged, api = workflowScheduleApi }) {
  const state = { workflow: null, schedule: null, loading: false, loadFailed: false, requestId: 0 };
  const context = Object.freeze({ get, toast, onChanged, api, state });
  get('workflowScheduleSave').addEventListener('click', () => saveSchedule(context));
  get('workflowScheduleDelete').addEventListener('click', () => deleteSchedule(context));
  get('workflowScheduleEnabled').addEventListener('change', () => toggleSchedule(context));
  document.querySelectorAll('input[name="workflowScheduleMode"]').forEach(input => {
    input.addEventListener('change', () => renderScheduleMode(context));
  });
  return Object.freeze({ load: workflow => loadSchedule(context, workflow), clear: () => clearSchedule(context) });
}

async function loadSchedule(context, workflow) {
  const requestId = ++context.state.requestId;
  context.state.workflow = workflow;
  context.state.schedule = null;
  context.state.loading = Boolean(workflow?.id && workflow?.activeVersionId);
  context.state.loadFailed = false;
  setScheduleFields(context, null);
  renderSchedule(context);
  if (!context.state.loading) return;
  try {
    const schedule = normalizeSchedule(await context.api.get(workflow.id));
    if (requestId !== context.state.requestId) return;
    context.state.schedule = schedule;
    setScheduleFields(context, schedule);
  } catch (error) {
    if (requestId !== context.state.requestId) return;
    context.state.loadFailed = true;
    context.get('workflowScheduleError').textContent = error.message;
    context.toast('读取定时计划失败：' + error.message, 'err');
  } finally {
    if (requestId === context.state.requestId) {
      context.state.loading = false;
      renderSchedule(context);
    }
  }
}

function clearSchedule(context) {
  context.state.requestId += 1;
  context.state.workflow = null;
  context.state.schedule = null;
  context.state.loading = false;
  context.state.loadFailed = false;
  setScheduleFields(context, null);
  renderSchedule(context);
}

function renderSchedule(context) {
  const { workflow, schedule, loading, loadFailed } = context.state;
  const published = Boolean(workflow?.id && workflow?.activeVersionId);
  context.get('workflowScheduleUnavailable').hidden = published;
  context.get('workflowScheduleContent').hidden = !published;
  context.get('workflowScheduleSave').disabled = loading || loadFailed;
  context.get('workflowScheduleDelete').hidden = !schedule;
  context.get('workflowScheduleDelete').disabled = loading || loadFailed;
  context.get('workflowScheduleEnabled').disabled = loading || loadFailed;
  context.get('workflowScheduleStatus').textContent = schedule ? (schedule.enabled ? '已启用' : '已停用') : '未配置';
  context.get('workflowScheduleStatus').className = `workflow-schedule-badge ${schedule?.enabled ? 'enabled' : ''}`;
  context.get('workflowScheduleLoading').hidden = !loading;
}

function setScheduleFields(context, schedule) {
  const timezone = schedule?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
  const expression = schedule?.cronExpression || DEFAULT_CRON_EXPRESSION;
  const parsed = parseScheduleExpression(expression);
  context.get('workflowScheduleCron').value = expression;
  const mode = document.querySelector(`input[name="workflowScheduleMode"][value="${parsed.mode}"]`);
  if (mode) mode.checked = true;
  if (parsed.time) context.get('workflowScheduleTime').value = parsed.time;
  context.get('workflowScheduleMonthDay').value = String(parsed.monthDay || 1);
  const selectedDays = new Set(parsed.weekdays || []);
  context.get('workflowScheduleWeekdays').querySelectorAll('input').forEach(input => {
    input.checked = selectedDays.has(input.value) || (parsed.mode === 'daily' && input.value === '1');
  });
  renderScheduleMode(context);
  context.get('workflowScheduleTimezone').value = timezone;
  context.get('workflowScheduleEnabled').checked = schedule?.enabled ?? true;
  context.get('workflowScheduleNext').textContent = formatScheduleTime(schedule?.nextRunAt, timezone);
  context.get('workflowScheduleLast').textContent = formatScheduleTime(schedule?.lastScheduledAt, timezone);
  context.get('workflowScheduleMissed').textContent = formatScheduleTime(schedule?.lastMissedAt, timezone);
  const status = context.get('workflowScheduleLastStatus');
  status.textContent = scheduleStatusLabel(schedule?.lastExecutionStatus);
  status.className = `execution-status ${schedule?.lastExecutionStatus || ''}`;
}

function renderScheduleMode(context) {
  const mode = document.querySelector('input[name="workflowScheduleMode"]:checked')?.value || 'daily';
  context.get('workflowScheduleSimple').hidden = mode === 'custom';
  context.get('workflowScheduleCustom').hidden = mode !== 'custom';
  context.get('workflowScheduleWeekdays').hidden = mode !== 'weekly';
  context.get('workflowScheduleMonth').hidden = mode !== 'monthly';
}

function collectScheduleInput(context) {
  const mode = document.querySelector('input[name="workflowScheduleMode"]:checked')?.value || 'daily';
  const weekdays = [...context.get('workflowScheduleWeekdays').querySelectorAll('input:checked')].map(input => input.value);
  return validateScheduleInput({
    workflowId: context.state.workflow?.id,
    cronExpression: buildScheduleExpression({
      mode, weekdays, monthDay: context.get('workflowScheduleMonthDay').value,
      time: context.get('workflowScheduleTime').value,
      cronExpression: context.get('workflowScheduleCron').value,
    }),
    timezone: context.get('workflowScheduleTimezone').value,
    enabled: context.get('workflowScheduleEnabled').checked,
  });
}

async function saveSchedule(context) {
  const button = context.get('workflowScheduleSave');
  context.get('workflowScheduleError').textContent = '';
  try {
    button.disabled = true;
    context.state.schedule = normalizeSchedule(await context.api.upsert(collectScheduleInput(context)));
    setScheduleFields(context, context.state.schedule);
    await context.onChanged();
    context.get('workflowScheduleError').textContent = '';
    context.toast('定时计划已保存', 'ok');
  } catch (error) {
    context.get('workflowScheduleError').textContent = error.message;
  } finally {
    button.disabled = false;
    renderSchedule(context);
  }
}

async function toggleSchedule(context) {
  if (!context.state.schedule) return;
  const enabled = context.get('workflowScheduleEnabled').checked;
  context.get('workflowScheduleError').textContent = '';
  try {
    context.get('workflowScheduleEnabled').disabled = true;
    context.state.schedule = normalizeSchedule(await context.api.setEnabled(context.state.workflow.id, enabled));
    setScheduleFields(context, context.state.schedule);
    await context.onChanged();
    context.toast(enabled ? '定时计划已启用' : '定时计划已停用', 'ok');
  } catch (error) {
    context.get('workflowScheduleError').textContent = error.message;
  } finally { renderSchedule(context); }
}

async function deleteSchedule(context) {
  if (!context.state.schedule || !confirm('确定删除该流水线的定时计划吗？')) return;
  context.get('workflowScheduleError').textContent = '';
  try {
    context.get('workflowScheduleDelete').disabled = true;
    await context.api.delete(context.state.workflow.id);
    context.state.schedule = null;
    setScheduleFields(context, null);
    await context.onChanged();
    context.toast('定时计划已删除', 'ok');
  } catch (error) {
    context.get('workflowScheduleError').textContent = error.message;
  } finally { renderSchedule(context); }
}
