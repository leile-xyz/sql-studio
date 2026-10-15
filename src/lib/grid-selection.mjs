export const NO_GRID_ROW = -1;
export const EMPTY_GRID_SELECTION = Object.freeze({
  selectedRows: Object.freeze([]),
  activeRow: NO_GRID_ROW,
  anchorRow: NO_GRID_ROW,
  selectedColumn: NO_GRID_ROW,
});

function orderedRows(rows) {
  return Object.freeze([...new Set(rows)].sort((left, right) => left - right));
}

function rangeRows(anchor, row) {
  const start = Math.min(anchor, row);
  const end = Math.max(anchor, row);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function selectedRowsForClick(state, options, anchor) {
  if (options.range) {
    const range = rangeRows(anchor, options.rowIndex);
    return orderedRows(options.toggle ? [...state.selectedRows, ...range] : range);
  }
  if (!options.toggle) return Object.freeze([options.rowIndex]);
  return state.selectedRows.includes(options.rowIndex)
    ? Object.freeze(state.selectedRows.filter(row => row !== options.rowIndex))
    : orderedRows([...state.selectedRows, options.rowIndex]);
}

export function selectGridRows(state, options) {
  if (!Number.isSafeInteger(options.rowIndex) || options.rowIndex < 0 || options.rowIndex >= options.rowCount) {
    throw new Error('选择的行超出当前结果范围');
  }
  const anchorRow = options.range && state.anchorRow !== NO_GRID_ROW ? state.anchorRow : options.rowIndex;
  const selectedRows = selectedRowsForClick(state, options, anchorRow);
  const activeRow = selectedRows.includes(options.rowIndex) ? options.rowIndex : selectedRows.at(-1) ?? NO_GRID_ROW;
  return Object.freeze({
    selectedRows, activeRow, anchorRow,
    selectedColumn: activeRow === options.rowIndex ? options.columnIndex : NO_GRID_ROW,
  });
}

export function gridSelectionLabel(view, state) {
  if (!state.selectedRows.length) return '';
  if (state.selectedRows.length > 1) return '已选 ' + state.selectedRows.length + ' 行';
  const row = '行 ' + (view.start + state.activeRow + 1);
  return state.selectedColumn < 0 ? row : row + ' · ' + view.data.columns[state.selectedColumn];
}
