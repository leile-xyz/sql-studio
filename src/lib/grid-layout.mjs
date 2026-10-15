export function applyGridSelection(table, state) {
  const selected = new Set(state.selectedRows);
  Array.from(table.tBodies[0].rows).forEach((row, index) => {
    row.classList.toggle('row-selected', selected.has(index));
    row.setAttribute('aria-selected', String(selected.has(index)));
  });
  table.dataset.selectedCount = String(selected.size);
  table.querySelectorAll('.cell-sel').forEach(cell => cell.classList.remove('cell-sel'));
  const row = table.tBodies[0].rows[state.activeRow];
  if (!row) return;
  if (state.selectedColumn >= 0) row.cells[state.selectedColumn + 1].classList.add('cell-sel');
}

function freezeColumns(row, count) {
  Array.from(row.cells).forEach((cell, index) => {
    const frozen = index > 0 && index <= count;
    cell.classList.toggle('frozen-column', frozen);
    cell.classList.toggle('frozen-column-end', count > 0 && index === count);
    if (frozen) cell.style.left = 'var(--grid-left-' + (index - 1) + ')';
    else if (index > 0) cell.style.removeProperty('left');
  });
}

export function applyGridFreeze(table, state) {
  const rows = Array.from(table.tBodies[0].rows);
  const frozenRows = Math.min(state.frozenRows, rows.length);
  table.dataset.frozenRows = String(frozenRows);
  table.dataset.frozenColumns = String(state.frozenColumns);
  Array.from(table.rows).forEach(row => freezeColumns(row, state.frozenColumns));
  rows.forEach((row, index) => {
    row.classList.toggle('frozen-row', index < frozenRows);
    row.classList.toggle('frozen-row-end', frozenRows > 0 && index === frozenRows - 1);
    if (index >= frozenRows) row.style.removeProperty('--grid-row-top');
  });
  syncGridLayout(table);
}

/** 偏移取真实渲染尺寸，列宽拖动和字体缩放后冻结区域仍与网格对齐。 */
export function syncGridLayout(table) {
  const header = table.tHead.rows[0];
  let left = 0;
  Array.from(header.cells).forEach((cell, index) => {
    if (index > 0) table.style.setProperty('--grid-left-' + (index - 1), left + 'px');
    left += cell.getBoundingClientRect().width;
  });
  let top = header.getBoundingClientRect().height;
  const frozenRows = Number(table.dataset.frozenRows || 0);
  Array.from(table.tBodies[0].rows).slice(0, frozenRows).forEach(row => {
    row.style.setProperty('--grid-row-top', top + 'px');
    top += row.getBoundingClientRect().height;
  });
}
