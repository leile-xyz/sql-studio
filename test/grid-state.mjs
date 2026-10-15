import assert from 'node:assert/strict';
import { createGridStateStore, EMPTY_GRID_STATE, resolveGridView } from '../src/lib/grid-state.mjs';
import { renderGridMenu } from '../src/lib/grid-menu.mjs';
import { EMPTY_GRID_SELECTION, gridSelectionLabel, selectGridRows } from '../src/lib/grid-selection.mjs';

const SELECTION_ROW_COUNT = 10;
const choose = (state, rowIndex, modifiers = {}) => selectGridRows(state, {
  rowIndex, columnIndex: 0, rowCount: SELECTION_ROW_COUNT, ...modifiers,
});

function testSelectionModifiers() {
  const initial = choose(EMPTY_GRID_SELECTION, 2);
  assert.deepEqual(initial.selectedRows, [2]);
  assert.equal(initial.anchorRow, 2);
  const forward = choose(initial, 5, { range: true });
  assert.deepEqual(forward.selectedRows, [2, 3, 4, 5]);
  assert.deepEqual(choose(forward, 3, { range: true }).selectedRows, [2, 3], '反复 Shift 点击可以缩小区间');
  const backward = choose(forward, 0, { range: true });
  assert.deepEqual(backward.selectedRows, [0, 1, 2]);
  assert.equal(backward.anchorRow, 2, 'Shift 连选不移动起点');
  const appended = choose(backward, 7, { toggle: true });
  assert.deepEqual(appended.selectedRows, [0, 1, 2, 7]);
  assert.equal(appended.anchorRow, 7);
  const removed = choose(appended, 1, { toggle: true });
  assert.deepEqual(removed.selectedRows, [0, 2, 7]);
  assert.equal(removed.selectedColumn, -1, '取消行选择后不能复制被取消的单元格');
  const combined = choose(removed, 4, { toggle: true, range: true });
  assert.deepEqual(combined.selectedRows, [0, 1, 2, 3, 4, 7]);
  assert.equal(combined.anchorRow, 1);
  const single = choose(combined, 6);
  assert.deepEqual(single.selectedRows, [6], '普通点击替换已有选择');
  const empty = choose(single, 6, { toggle: true });
  assert.deepEqual(empty.selectedRows, []);
  assert.equal(empty.activeRow, -1);
  assert.equal(empty.anchorRow, 6);
  assert.deepEqual(choose(empty, 4, { range: true }).selectedRows, [4, 5, 6]);
  assert.deepEqual(choose(EMPTY_GRID_SELECTION, 4, { range: true }).selectedRows, [4]);
  assert.deepEqual(initial.selectedRows, [2], '不修改传入的选择快照');
  assert.ok(Object.isFrozen(combined) && Object.isFrozen(combined.selectedRows));
  for (const invalid of [-1, SELECTION_ROW_COUNT, 1.5, NaN]) {
    assert.throws(() => choose(initial, invalid), /超出当前结果范围/);
  }
  const view = { start: 100, data: { columns: ['id'] } };
  assert.equal(gridSelectionLabel(view, initial), '行 103 · id');
  assert.equal(gridSelectionLabel(view, combined), '已选 6 行');
  assert.equal(gridSelectionLabel(view, empty), '');
}

const columns = Object.freeze(['id', 'name']);
const rows = Object.freeze([Object.freeze([1, 'one']), Object.freeze([2, 'two'])]);
const data = Object.freeze({ columns, rows });
const owner = Object.freeze({ id: 1, type: 'table' });
const view = Object.freeze({ tab: owner, key: 'table', data });
const states = createGridStateStore();
assert.deepEqual(states.read(null), EMPTY_GRID_STATE);
assert.deepEqual(states.read(view), EMPTY_GRID_STATE);

const selected = states.update(view, { ...choose(EMPTY_GRID_SELECTION, 1), frozenRows: 2, frozenColumns: 1 });
assert.ok(Object.isFrozen(selected));
assert.ok(Object.isFrozen(selected.selectedRows));
assert.equal(states.read(view), selected);
const otherOwner = Object.freeze({ id: 2, type: 'table' });
const otherView = Object.freeze({ ...view, tab: otherOwner });
assert.deepEqual(states.read(otherView), EMPTY_GRID_STATE);
assert.equal(states.read(view), selected, '切换标签后保留选中行和冻结位置');

const refreshed = Object.freeze({ ...view, data: Object.freeze({ columns: [...columns], rows: [[3, 'three']] }) });
assert.deepEqual(states.read(refreshed), { ...EMPTY_GRID_STATE, frozenRows: 2, frozenColumns: 1 });
states.update(refreshed, choose(EMPTY_GRID_SELECTION, 0));
assert.deepEqual(states.read({ ...refreshed, start: 100 }), { ...EMPTY_GRID_STATE, frozenRows: 2, frozenColumns: 1 }, '即使复用相同数据对象，换页也必须清除选择与起点');
const renamed = Object.freeze({ ...refreshed, data: { columns: ['id', 'value'], rows: [[3, 'three']] } });
assert.deepEqual(states.read(renamed), EMPTY_GRID_STATE, '列结构变化不能沿用原列的冻结位置');

const consoleOwner = Object.freeze({ id: 3, type: 'console' });
const firstResult = Object.freeze({ tab: consoleOwner, key: 0, data });
const secondResult = Object.freeze({ tab: consoleOwner, key: 1, data });
states.update(firstResult, { selectedRows: [0, 1], activeRow: 0, anchorRow: 0, selectedColumn: 1, frozenRows: 1, frozenColumns: 2 });
assert.deepEqual(states.read(secondResult), EMPTY_GRID_STATE);
states.update(secondResult, { ...choose(EMPTY_GRID_SELECTION, 1), selectedColumn: -1 });
assert.deepEqual(states.read(firstResult).selectedRows, [0, 1]);
assert.equal(states.read(firstResult).frozenColumns, 2);
assert.equal(states.read(secondResult).frozenColumns, 0);
assert.deepEqual(states.read(secondResult).selectedRows, [1]);
states.update(firstResult, { frozenRows: 0, frozenColumns: 0 });
assert.deepEqual(states.read(firstResult).selectedRows, [0, 1], '取消冻结应保留多选集合');

const tab = Object.freeze({ type: 'table', page: 3, pageSize: 20, data });
assert.equal(resolveGridView(tab).start, 40);
assert.equal(resolveGridView(tab).context, tab);
assert.equal(resolveGridView({ type: 'table', data: null }), null);
const context = Object.freeze({ db: 'db', dbType: 'pgsql', schema: 'public' });
const result = Object.freeze({ ...data, context, ok: true, pageable: true, page: 2, pageSize: 100 });
const consoleTab = Object.freeze({ type: 'console', results: [result], activeResult: 0 });
assert.equal(resolveGridView(consoleTab).start, 100);
assert.equal(resolveGridView(consoleTab).context, context);
assert.equal(resolveGridView({ ...consoleTab, results: [] }), null);
assert.equal(resolveGridView({ ...consoleTab, results: [{ ok: false }] }), null);

const menu = renderGridMenu({
  rowIndex: 1, columnIndex: 0, columnName: '<img src=x onerror=alert(1)>',
  start: 100, state: { ...selected, frozenRows: 2, frozenColumns: 1 },
});
assert.match(menu, /冻结到第 102 行/);
assert.match(menu, /冻结到第 1 列/);
assert.ok(menu.includes('&lt;img') && !menu.includes('<img'), '列名必须按文本转义');
assert.ok(menu.includes('取消全部冻结'));
for (const format of ['JSON', 'INSERT', 'CSV', 'TSV']) assert.ok(menu.includes('复制整行为 ' + format));
const headerMenu = renderGridMenu({ rowIndex: -1, columnIndex: 1, columnName: 'name', start: 0, state: EMPTY_GRID_STATE });
assert.ok(!headerMenu.includes('复制整行'));
assert.ok(headerMenu.includes('冻结到第 2 列'));
assert.ok(!headerMenu.includes('取消冻结'));
const multiMenu = renderGridMenu({ rowIndex: 1, columnIndex: 0, columnName: 'id', start: 0, state: { ...selected, selectedRows: [0, 1] } });
assert.ok(multiMenu.includes('已选 2 行'));
assert.ok(multiMenu.includes('复制所选 2 行为 JSON'));
assert.ok(multiMenu.includes('冻结到第 2 行'), '冻结边界使用右键点击的行');

testSelectionModifiers();
console.log('PASS grid state: Shift/Ctrl selection, anchors, tab/result isolation, pagination and freeze reset');
