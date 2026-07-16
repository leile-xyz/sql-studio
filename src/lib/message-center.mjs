import { renderExecutionDetail } from './execution-detail.mjs';

const SEVERITY_META = Object.freeze({
  success: Object.freeze({ icon: '✓', label: '成功' }),
  error: Object.freeze({ icon: '!', label: '失败' }),
  warning: Object.freeze({ icon: '!', label: '警告' }),
  info: Object.freeze({ icon: 'i', label: '通知' }),
});

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function invoke(command, args = {}) {
  return window.__TAURI__.core.invoke(command, args).catch(error => {
    throw new Error(typeof error === 'string' ? error : error?.message || '通知请求失败');
  });
}

export const messageApi = Object.freeze({
  list: () => invoke('message_list'),
  unreadCount: () => invoke('message_unread_count'),
  markRead: messageId => invoke('message_mark_read', { messageId }),
  markAllRead: () => invoke('message_mark_all_read'),
  execution: executionId => invoke('get_workflow_execution', { executionId }),
});

export function bindMessageCenter({ toast, messages = messageApi }) {
  const get = id => document.getElementById(id);
  const context = Object.freeze({ get, toast, messages });
  get('btnMessages').addEventListener('click', () => openCenter(context));
  get('messageClose').addEventListener('click', () => closeCenter(context));
  get('messageRefresh').addEventListener('click', () => loadMessages(context));
  get('messageMarkAll').addEventListener('click', () => markAllRead(context));
  get('messageList').addEventListener('click', event => openMessage(context, event));
  refreshUnread(context).catch(error => toast('读取未读通知失败：' + error.message, 'err'));
}

function closeCenter(context) {
  context.get('messageMask').classList.remove('show');
}

async function openCenter(context) {
  context.get('messageMask').classList.add('show');
  await loadMessages(context);
}

async function loadMessages(context) {
  try {
    const items = await context.messages.list() || [];
    context.get('messageList').innerHTML = renderMessageList(items);
    context.get('messageListCount').textContent = `${items.length} 条通知`;
    await refreshUnread(context);
  } catch (error) { context.toast('读取通知失败：' + error.message, 'err'); }
}

function severityMeta(severity) {
  return SEVERITY_META[severity] || SEVERITY_META.info;
}

function formatMessageTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function renderMessageList(items) {
  if (!items.length) return '<div class="message-empty"><span class="message-empty-icon">✓</span><strong>暂无通知</strong><p>新的流水线执行结果会显示在这里</p></div>';
  return items.map(item => {
    const severity = Object.hasOwn(SEVERITY_META, item.severity) ? item.severity : 'info';
    const meta = severityMeta(severity);
    return `<button type="button" class="message-item severity-${severity} ${item.readAt ? '' : 'unread'}" data-message-id="${escapeHtml(item.id)}" data-execution-id="${escapeHtml(item.executionId || '')}"><span class="message-severity" title="${meta.label}">${meta.icon}</span><span class="message-content"><span class="message-item-title"><strong>${escapeHtml(item.title)}</strong>${item.readAt ? '' : '<i>未读</i>'}</span><span>${escapeHtml(item.content || item.body || '')}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatMessageTime(item.createdAt))}</time></span></button>`;
  }).join('');
}

async function refreshUnread(context) {
  const result = await context.messages.unreadCount();
  const count = Number(result?.count ?? result ?? 0);
  const badge = context.get('messageBadge');
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  context.get('messageUnreadSummary').textContent = count ? `${count} 条未读` : '已全部读取';
}

async function markAllRead(context) {
  try { await context.messages.markAllRead(); await loadMessages(context); }
  catch (error) { context.toast('全部标记已读失败：' + error.message, 'err'); }
}

async function openMessage(context, event) {
  const item = event.target.closest('[data-message-id]');
  if (!item) return;
  try {
    await context.messages.markRead(item.dataset.messageId);
    context.get('messageList').querySelectorAll('.message-item.active').forEach(element => element.classList.remove('active'));
    item.classList.remove('unread');
    item.classList.add('active');
    item.querySelector('.message-item-title i')?.remove();
    await refreshUnread(context);
    if (item.dataset.executionId) await showExecution(context, item.dataset.executionId);
  } catch (error) { context.toast('打开通知失败：' + error.message, 'err'); }
}

async function showExecution(context, executionId) {
  const detail = context.get('messageExecutionDetail');
  detail.innerHTML = '<div class="message-empty"><span class="message-loading"></span><strong>正在读取执行详情</strong></div>';
  detail.innerHTML = renderExecutionDetail(await context.messages.execution(executionId));
}
