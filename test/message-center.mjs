import assert from 'node:assert/strict';
import { renderMessageDetail, renderMessageList } from '../src/lib/message-center.mjs';

const html = renderMessageList([{ id: 'm1', severity: 'error', title: '执行失败', content: 'SQL 错误', createdAt: '2026-07-16T07:24:11Z' }]);
assert.match(html, /data-message-id="m1"/);
assert.match(html, /class="message-item severity-error unread"/);
assert.match(html, /class="message-severity"[^>]*>!</);
assert.match(html, />未读</);
assert.match(html, /datetime="2026-07-16T07:24:11Z"/);

const read = renderMessageList([{ id: 'm2', severity: 'success', title: '执行成功', content: '完成', createdAt: 'now', readAt: 'now' }]);
assert.match(read, /severity-success/);
assert.doesNotMatch(read, /未读/);
assert.match(renderMessageList([]), /新的消息和流水线执行结果会显示在这里/);

const systemDetail = renderMessageDetail({ messageKind: 'system', severity: 'info', title: '版本提醒', content: '已完成升级', createdAt: 'now' });
assert.match(systemDetail, /消息内容/);
assert.match(systemDetail, /系统通知/);
assert.match(systemDetail, /已完成升级/);
assert.doesNotMatch(systemDetail, /关联执行/);

const executionDetail = renderMessageDetail({ messageKind: 'workflow_execution', severity: 'success', title: '执行成功', content: '运行完成', executionId: 'e1' }, '<div>执行记录</div>');
assert.match(executionDetail, /关联执行/);
assert.match(executionDetail, /执行记录/);
console.log('PASS  message center: severity, unread state and empty state');
