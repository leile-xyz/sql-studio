import { renderExecutionDetail } from './execution-detail.mjs';

const SEVERITY_META = Object.freeze({
  success: Object.freeze({ icon: '✓', label: '成功' }),
  error: Object.freeze({ icon: '!', label: '失败' }),
  warning: Object.freeze({ icon: '!', label: '警告' }),
  info: Object.freeze({ icon: 'i', label: '通知' }),
});

const MESSAGE_KIND_LABELS = Object.freeze({
  workflow_execution: '流水线执行',
  schedule_missed: '调度提醒',
  system: '系统通知',
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
  const state = { items: [] };
  const context = Object.freeze({ get, toast, messages, state });
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
    context.state.items = items;
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
  if (!items.length) return '<div class="message-empty"><span class="message-empty-icon">✓</span><strong>暂无通知</strong><p>新的消息和流水线执行结果会显示在这里</p></div>';
  return items.map(item => {
    const severity = Object.hasOwn(SEVERITY_META, item.severity) ? item.severity : 'info';
    const meta = severityMeta(severity);
    return `<button type="button" class="message-item severity-${severity} ${item.readAt ? '' : 'unread'}" data-message-id="${escapeHtml(item.id)}" data-execution-id="${escapeHtml(item.executionId || '')}"><span class="message-severity" title="${meta.label}">${meta.icon}</span><span class="message-content"><span class="message-item-title"><strong>${escapeHtml(item.title)}</strong>${item.readAt ? '' : '<i>未读</i>'}</span><span>${escapeHtml(item.content || item.body || '')}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatMessageTime(item.createdAt))}</time></span></button>`;
  }).join('');
}

function messageKindLabel(kind) {
  return MESSAGE_KIND_LABELS[kind] || '普通通知';
}

export function renderMessageDetail(item, executionHtml = '') {
  const severity = Object.hasOwn(SEVERITY_META, item.severity) ? item.severity : 'info';
  const meta = severityMeta(severity);
  const content = item.content || item.body || '此消息没有正文内容。';
  const execution = item.executionId
    ? `<section class="message-related-execution"><div class="message-detail-section-head"><strong>关联执行</strong><span>本消息对应的流水线执行记录</span></div>${executionHtml}</section>`
    : '';
  return `<article class="message-detail-card"><header><span class="message-detail-icon severity-${severity}">${meta.icon}</span><div><span>${escapeHtml(messageKindLabel(item.messageKind))}</span><h3>${escapeHtml(item.title || '未命名消息')}</h3></div></header><dl class="message-detail-meta"><div><dt>消息类型</dt><dd>${escapeHtml(messageKindLabel(item.messageKind))}</dd></div><div><dt>状态</dt><dd>${escapeHtml(meta.label)}</dd></div><div><dt>接收时间</dt><dd>${escapeHtml(formatMessageTime(item.createdAt))}</dd></div></dl><section class="message-detail-content"><strong>消息内容</strong><p>${escapeHtml(content)}</p></section></article>${execution}`;
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
    const message = context.state.items.find(candidate => String(candidate.id) === item.dataset.messageId);
    if (!message) throw new Error('未找到所选消息');
    await showMessageDetail(context, message);
  } catch (error) { context.toast('打开通知失败：' + error.message, 'err'); }
}

async function showMessageDetail(context, message) {
  const detail = context.get('messageDetail');
  if (!message.executionId) {
    detail.innerHTML = renderMessageDetail(message);
    return;
  }
  const loading = '<div class="message-related-loading"><span class="message-loading"></span><span>正在读取关联执行…</span></div>';
  detail.innerHTML = renderMessageDetail(message, loading);
  const execution = renderExecutionDetail(await context.messages.execution(message.executionId));
  detail.innerHTML = renderMessageDetail(message, execution);
}
