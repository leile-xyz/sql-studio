import { renderExecutionDetail } from './execution-detail.mjs';

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function bindWorkflowHistory(context) {
  const { get } = context;
  get('workflowRun').addEventListener('click', () => runManual(context));
  get('workflowHistoryRefresh').addEventListener('click', () => loadHistory(context));
  get('workflowHistoryList').addEventListener('click', event => openExecution(context, event));
  return Object.freeze({ load: () => loadHistory(context), clear: () => clearHistory(context) });
}

async function runManual(context) {
  const workflowId = context.state.draft?.id;
  if (!workflowId) return;
  const session = context.getAppState();
  try {
    context.get('workflowRun').disabled = true;
    const result = await context.workflows.runManual({ workflowId, environmentId: session.activeEnvId, username: session.username, origin: session.origin });
    context.toast(result?.status === 'failed' ? '执行失败，请查看节点详情' : '手动执行成功', result?.status === 'failed' ? 'err' : 'ok');
    await loadHistory(context, result?.executionId || result?.id || result);
  } catch (error) {
    context.toast('手动执行失败：' + error.message, 'err');
    await loadHistory(context);
  } finally { context.get('workflowRun').disabled = false; }
}

async function loadHistory(context, selectedId) {
  const workflowId = context.state.draft?.id;
  if (!workflowId) return clearHistory(context);
  try {
    const items = await context.workflows.executions(workflowId) || [];
    context.get('workflowHistoryList').innerHTML = renderExecutionList(items, selectedId);
    if (selectedId) await showExecution(context, selectedId);
  } catch (error) { context.get('workflowHistoryDetail').innerHTML = `<div class="err-line">${escapeHtml(error.message)}</div>`; }
}

export function renderExecutionList(items, selectedId) {
  if (!items.length) return '<div class="workflow-history-empty">暂无执行记录</div>';
  return items.map(item => `<button type="button" class="workflow-history-item ${item.id === selectedId ? 'active' : ''}" data-execution-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.status)}</strong>${escapeHtml(item.triggerType || 'manual')}</span><time>${escapeHtml(item.startedAt || item.createdAt)}</time></button>`).join('');
}

async function openExecution(context, event) {
  const id = event.target.closest('[data-execution-id]')?.dataset.executionId;
  if (id) await showExecution(context, id);
}

async function showExecution(context, id) {
  const detail = context.get('workflowHistoryDetail');
  detail.innerHTML = '<div class="workflow-history-empty">读取执行详情…</div>';
  try { detail.innerHTML = renderExecutionDetail(await context.workflows.execution(id)); }
  catch (error) { detail.innerHTML = `<div class="err-line">${escapeHtml(error.message)}</div>`; }
}

function clearHistory(context) {
  context.get('workflowHistoryList').innerHTML = '<div class="workflow-history-empty">保存并发布后可手动执行。</div>';
  context.get('workflowHistoryDetail').innerHTML = '';
}
