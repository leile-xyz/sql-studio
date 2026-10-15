import { isPostgresType } from './db-context.mjs';
import { applyGridFreeze, applyGridSelection, syncGridLayout } from './grid-layout.mjs';
import { showGridMenu } from './grid-menu.mjs';
import { gridSelectionLabel, selectGridRows } from './grid-selection.mjs';
import { createGridStateStore, resolveGridView } from './grid-state.mjs';
import { createRowCopyActions } from './row-copy-actions.mjs';

function copySnapshot(options) {
  const view = options.view;
  const source = Object.freeze({ ...view.context });
  const target = view.tab.type === 'table' ? Object.freeze({
    table: source.table,
    namespace: isPostgresType(source.dbType) ? source.schema : source.db,
  }) : null;
  return Object.freeze({
    format: options.format, includeHeaders: options.includeHeaders, target, context: source, dbType: source.dbType,
    columns: Object.freeze([...view.data.columns]),
    rows: Object.freeze(options.rowIndices.map(index => Object.freeze([...view.data.rows[index]]))),
  });
}

function isGridCopyShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return false;
  return !!event.target.closest('#tabbody table.grid');
}

class GridInteractions {
  constructor(options) {
    this.options = Object.freeze({ ...options });
    this.states = createGridStateStore();
    this.copying = createRowCopyActions(options);
    this.mountedTable = null;
    this.menuContext = null;
    this.restoreFocus = false;
    this.events = new options.document.defaultView.AbortController();
    this.observer = new options.document.defaultView.ResizeObserver(() => {
      if (this.mountedTable?.isConnected) syncGridLayout(this.mountedTable);
    });
    const signal = this.events.signal;
    options.document.addEventListener('mousedown', event => this.onModifiedMouseDown(event), { signal });
    options.document.addEventListener('keydown', event => this.onCopyKeydown(event), { signal });
  }

  unmount() {
    if (this.mountedTable) this.restoreFocus = this.mountedTable.contains(this.options.document.activeElement);
    this.observer.disconnect();
    this.mountedTable = null;
    this.menuContext = null;
    this.options.document.getElementById('gridContextMenu').classList.remove('show');
    this.options.onSelectionChange('');
  }

  mount() {
    this.unmount();
    this.mountedTable = this.options.document.querySelector('#tabbody table.grid');
    const view = resolveGridView(this.options.getCurrentTab());
    if (!this.mountedTable || !view) { this.restoreFocus = false; return; }
    const state = this.states.read(view);
    applyGridFreeze(this.mountedTable, state);
    applyGridSelection(this.mountedTable, state);
    this.options.onSelectionChange(gridSelectionLabel(view, state));
    this.observer.observe(this.mountedTable);
    if (this.restoreFocus) this.mountedTable.focus({ preventScroll: true });
    this.restoreFocus = false;
  }

  updateSelection(view, change) {
    const state = this.states.update(view, change);
    applyGridSelection(this.mountedTable, state);
    this.options.onSelectionChange(gridSelectionLabel(view, state));
    this.mountedTable.focus({ preventScroll: true });
  }

  selectCell(cell, event = {}) {
    const view = resolveGridView(this.options.getCurrentTab());
    if (!view) return;
    const change = selectGridRows(this.states.read(view), {
      rowIndex: Number(cell.closest('tr').dataset.ri),
      columnIndex: cell.classList.contains('gutter') ? -1 : Number(cell.dataset.ci),
      rowCount: view.data.rows.length,
      range: !!event.shiftKey, toggle: !!(event.ctrlKey || event.metaKey),
    });
    this.updateSelection(view, change);
  }

  onModifiedMouseDown(event) {
    if (event.button !== 0 || !(event.shiftKey || event.ctrlKey || event.metaKey)) return;
    if (!event.target.closest('#tabbody table.grid tbody td')) return;
    event.preventDefault();
    this.options.document.defaultView.getSelection().removeAllRanges();
  }

  openMenu(event) {
    this.options.hideMenus();
    const view = resolveGridView(this.options.getCurrentTab());
    if (!view) return;
    const cell = event.element;
    const row = cell.closest('tbody tr');
    const rowIndex = row ? Number(row.dataset.ri) : -1;
    const columnIndex = cell.classList.contains('gutter') ? -1 : Number(cell.dataset.ci);
    if (row) {
      if (this.states.read(view).selectedRows.includes(rowIndex)) this.updateSelection(view, { activeRow: rowIndex, selectedColumn: columnIndex });
      else this.selectCell(cell);
    }
    const state = this.states.read(view);
    this.menuContext = Object.freeze({ view, rowIndex, columnIndex, rowIndices: state.selectedRows, table: cell.closest('table') });
    showGridMenu(this.options.document.getElementById('gridContextMenu'), {
      rowIndex, columnIndex, state, start: view.start,
      columnName: view.data.columns[columnIndex],
      clientX: event.clientX, clientY: event.clientY,
    });
  }

  freeze(axis) {
    const context = this.menuContext;
    if (!context) return;
    const change = axis === 'rows' ? { frozenRows: context.rowIndex + 1 } : { frozenColumns: context.columnIndex + 1 };
    const state = this.states.update(context.view, change);
    applyGridFreeze(context.table, state);
    this.options.hideMenus();
  }

  unfreeze(axis) {
    const context = this.menuContext;
    if (!context) return;
    const change = axis === 'all' ? { frozenRows: 0, frozenColumns: 0 } : { [axis === 'rows' ? 'frozenRows' : 'frozenColumns']: 0 };
    const state = this.states.update(context.view, change);
    applyGridFreeze(context.table, state);
    this.options.hideMenus();
  }

  copy(format) {
    if (!this.menuContext || this.menuContext.rowIndex < 0) return;
    const snapshot = copySnapshot({ ...this.menuContext, format });
    this.options.hideMenus();
    this.mountedTable.focus({ preventScroll: true });
    return this.copying.copy(snapshot);
  }

  onCopyKeydown(event) {
    if (!isGridCopyShortcut(event)) return;
    if (String(this.options.document.defaultView.getSelection())) return;
    const view = resolveGridView(this.options.getCurrentTab());
    if (!view) return;
    const state = this.states.read(view);
    if (!state.selectedRows.length) return;
    event.preventDefault();
    if (state.selectedRows.length === 1 && state.selectedColumn >= 0) {
      this.copyCell(view.data.rows[state.activeRow][state.selectedColumn]);
      return;
    }
    this.copying.copy(copySnapshot({ view, rowIndices: state.selectedRows, format: 'tsv', includeHeaders: false }));
  }

  async copyCell(value) {
    try {
      await this.options.writeClipboard(value === null ? '' : String(value));
    } catch (error) {
      this.options.toast(error.message, 'err');
    }
  }

  dispose() {
    this.events.abort();
    this.unmount();
  }
}

export function createGridInteractions(options) {
  const grid = new GridInteractions(options);
  return Object.freeze({
    mount: () => grid.mount(), unmount: () => grid.unmount(), dispose: () => grid.dispose(),
    selectCell: (cell, event) => grid.selectCell(cell, event), openMenu: event => grid.openMenu(event),
    freeze: axis => grid.freeze(axis), unfreeze: axis => grid.unfreeze(axis), copy: format => grid.copy(format),
  });
}
