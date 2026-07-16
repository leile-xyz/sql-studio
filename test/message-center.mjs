import assert from 'node:assert/strict';
import { renderMessageList } from '../src/lib/message-center.mjs';

const html = renderMessageList([{ id: 'm1', severity: 'error', title: '执行失败', content: 'SQL 错误', createdAt: '2026-07-16T07:24:11Z' }]);
assert.match(html, /data-message-id="m1"/);
assert.match(html, /class="message-item severity-error unread"/);
assert.match(html, /class="message-severity"[^>]*>!</);
assert.match(html, />未读</);
assert.match(html, /datetime="2026-07-16T07:24:11Z"/);

const read = renderMessageList([{ id: 'm2', severity: 'success', title: '执行成功', content: '完成', createdAt: 'now', readAt: 'now' }]);
assert.match(read, /severity-success/);
assert.doesNotMatch(read, /未读/);
assert.match(renderMessageList([]), /新的流水线执行结果会显示在这里/);
console.log('PASS  message center: severity, unread state and empty state');
