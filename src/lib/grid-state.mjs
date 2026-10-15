import { EMPTY_GRID_SELECTION } from './grid-selection.mjs';

export const EMPTY_GRID_STATE = Object.freeze({
  ...EMPTY_GRID_SELECTION,
  frozenRows: 0,
  frozenColumns: 0,
});

export function resolveGridView(tab) {
  if (!tab) return null;
  if (tab.type === 'table') {
    if (!tab.data) return null;
    return Object.freeze({
      tab, key: 'table', data: tab.data, context: tab,
      start: (tab.page - 1) * tab.pageSize,
    });
  }
  const results = tab.results || [];
  if (!results.length) return null;
  const index = Number.isInteger(tab.activeResult) ? tab.activeResult : results.length - 1;
  const key = Math.max(0, Math.min(index, results.length - 1));
  const data = results[key];
  if (!data.ok) return null;
  return Object.freeze({
    tab, key, data, context: data.context,
    start: data.pageable ? (data.page - 1) * data.pageSize : 0,
  });
}

/** 每张表和每个结果页签分别保存状态；换页或刷新数据后清除行选择。 */
export function createGridStateStore() {
  const tabs = new WeakMap();

  function read(view) {
    if (!view) return EMPTY_GRID_STATE;
    const entries = tabs.get(view.tab) || new Map();
    const previous = entries.get(view.key);
    const columns = JSON.stringify(view.data.columns);
    let state = previous?.columns === columns ? previous.state : EMPTY_GRID_STATE;
    if (previous?.rows !== view.data.rows || previous?.start !== view.start) {
      state = Object.freeze({ ...state, ...EMPTY_GRID_SELECTION });
    }
    const record = Object.freeze({ columns, rows: view.data.rows, start: view.start, state });
    tabs.set(view.tab, new Map(entries).set(view.key, record));
    return state;
  }

  function update(view, change) {
    const previous = read(view);
    const state = Object.freeze({
      ...previous, ...change,
      selectedRows: Object.freeze([...(change.selectedRows ?? previous.selectedRows)]),
    });
    const entries = tabs.get(view.tab);
    const record = Object.freeze({ ...entries.get(view.key), state });
    tabs.set(view.tab, new Map(entries).set(view.key, record));
    return state;
  }

  return Object.freeze({ read, update });
}
