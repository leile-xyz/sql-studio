import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  buildScheduleExpression,
  formatScheduleTime,
  normalizeSchedule,
  scheduleStatusLabel,
  parseScheduleExpression,
  validateScheduleInput,
} from '../src/lib/workflow-schedule.mjs';

const input = validateScheduleInput({
  workflowId: 'workflow-1', cronExpression: ' 0   9 * * * ', timezone: DEFAULT_SCHEDULE_TIMEZONE, enabled: true,
});
assert.deepEqual(input, {
  workflowId: 'workflow-1', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true,
});
assert.ok(Object.isFrozen(input));
assert.doesNotThrow(() => validateScheduleInput({ workflowId: 'w', cronExpression: '0 0 9 * * *', timezone: 'UTC' }));
assert.doesNotThrow(() => validateScheduleInput({ workflowId: 'w', cronExpression: '0 0 9 * * * *', timezone: 'America/New_York' }));
assert.throws(() => validateScheduleInput({ workflowId: 'w', cronExpression: '* * * *', timezone: 'UTC' }), /5、6 或 7/);
assert.throws(() => validateScheduleInput({ workflowId: 'w', cronExpression: '* * * * *', timezone: 'Shanghai' }), /IANA/);

const schedule = normalizeSchedule({
  id: 'schedule-1', workflowId: 'workflow-1', workflowVersionId: 'version-1',
  cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true,
  nextRunAt: '2026-07-17T01:00:00Z', lastExecutionStatus: 'succeeded',
});
assert.equal(schedule.nextRunAt, '2026-07-17T01:00:00Z');
assert.ok(Object.isFrozen(schedule));
assert.equal(formatScheduleTime(schedule.nextRunAt, schedule.timezone), '2026/07/17 09:00:00');
assert.equal(scheduleStatusLabel('succeeded'), '成功');
assert.equal(scheduleStatusLabel(null), '暂无执行');
assert.throws(() => normalizeSchedule({ id: 'schedule-1' }), /缺少必要字段/);

assert.deepEqual(parseScheduleExpression('0 9 * * *'), { mode: 'daily', time: '09:00', weekdays: [] });
assert.deepEqual(parseScheduleExpression('30 18 * * 1,3,5'), { mode: 'weekly', time: '18:30', weekdays: ['1', '3', '5'] });
assert.deepEqual(parseScheduleExpression('15 8 20 * *'), { mode: 'monthly', time: '08:15', monthDay: 20, weekdays: [] });
assert.deepEqual(parseScheduleExpression('0 0 9 * * *'), { mode: 'custom', cronExpression: '0 0 9 * * *' });
assert.equal(buildScheduleExpression({ mode: 'daily', time: '09:05' }), '5 9 * * *');
assert.equal(buildScheduleExpression({ mode: 'weekly', time: '18:30', weekdays: ['1', '3', '5'] }), '30 18 * * 1,3,5');
assert.equal(buildScheduleExpression({ mode: 'monthly', time: '08:15', monthDay: 20 }), '15 8 20 * *');
assert.equal(buildScheduleExpression({ mode: 'custom', cronExpression: ' 0  0 9 * * * ' }), '0 0 9 * * *');
assert.throws(() => buildScheduleExpression({ mode: 'weekly', time: '09:00', weekdays: [] }), /至少选择一个/);

console.log('PASS  workflow schedule: validation, normalization, timezone display and status labels');
