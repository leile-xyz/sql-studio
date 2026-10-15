import { visibleTabs } from './console-workspace.mjs';
import { showAllConsolesMenu, showConsoleMenu } from './console-menu-view.mjs';
import { filterWorkspaceTabs, renderTabBarView, renderTabListResults, renderTabListView, tabIdForKey } from './workspace-tabs-view.mjs';

const SCROLL_TOLERANCE = 1;
const SCROLL_PAGE_RATIO = 0.8;
const WHEEL_LINE_PIXELS = 18;
const WHEEL_LINE_MODE = 1;
const WHEEL_PAGE_MODE = 2;
const MENU_MARGIN = 8;
const MENU_GAP = 6;

class WorkspaceTabs {
  constructor(options) {
    this.options = Object.freeze({ ...options });
    this.root = options.root;
    this.menu = options.menu;
    this.document = options.root.ownerDocument;
    this.activeId = null;
    this.selectedId = null;
    this.events = new options.window.AbortController();
    this.resizeObserver = new options.window.ResizeObserver(() => this.onResize());
  }

  get scroller() { return this.root.querySelector('.tabs-scroll'); }
  get trigger() { return this.root.querySelector('[data-tab-action="toggle-list"]'); }
  get input() { return this.menu.querySelector('#tabListSearch'); }
  get listOpen() { return this.menu.classList.contains('show'); }

  viewOptions() {
    return { ...this.options.getState(), consoleIcon: this.options.icons.console, tableIcon: this.options.icons.table };
  }

  bind() {
    const signal = this.events.signal;
    this.root.addEventListener('click', event => this.onClick(event), { signal });
    this.root.addEventListener('keydown', event => this.onTabKeydown(event), { signal });
    this.root.addEventListener('wheel', event => this.onWheel(event), { signal, passive: false });
    this.root.addEventListener('scroll', () => this.syncOverflow(), { signal, capture: true });
    this.options.window.addEventListener('resize', () => this.onResize(), { signal });
    this.menu.addEventListener('click', event => this.onListClick(event), { signal });
    this.menu.addEventListener('input', () => this.updateList(), { signal });
    this.menu.addEventListener('keydown', event => this.onListKeydown(event), { signal });
    this.menu.addEventListener('focusout', event => {
      if (!this.menu.contains(event.relatedTarget) && !this.root.contains(event.relatedTarget)) this.hideList();
    }, { signal });
    this.document.addEventListener('pointerdown', event => {
      if (!this.menu.contains(event.target) && !this.root.contains(event.target)) this.hideList();
    }, { signal });
    this.resizeObserver.observe(this.root);
  }

  render(settings = {}) {
    const options = this.viewOptions();
    const scrollLeft = this.scroller?.scrollLeft ?? 0;
    const activeWasVisible = this.activeIsVisible();
    const focusedTab = this.root.contains(this.document.activeElement) && this.document.activeElement.closest('.tab');
    this.root.innerHTML = renderTabBarView(options);
    this.syncOverflow();
    this.scroller.scrollLeft = scrollLeft;
    if (settings.revealActive || options.activeTabId !== this.activeId || activeWasVisible) this.revealActive();
    this.activeId = options.activeTabId;
    if (focusedTab) this.focusActive();
    if (this.listOpen) {
      this.trigger.setAttribute('aria-expanded', 'true');
      this.updateList();
      this.positionList();
    }
    this.syncOverflow();
  }

  activeIsVisible() {
    const active = this.root.querySelector('.tab.active');
    if (!active || !this.scroller) return false;
    const tab = active.getBoundingClientRect();
    const viewport = this.scroller.getBoundingClientRect();
    return tab.left >= viewport.left - SCROLL_TOLERANCE && tab.right <= viewport.right + SCROLL_TOLERANCE;
  }

  revealActive() {
    const active = this.root.querySelector('.tab.active');
    if (!active) return;
    const tab = active.getBoundingClientRect();
    const viewport = this.scroller.getBoundingClientRect();
    if (tab.left < viewport.left) this.scroller.scrollLeft += tab.left - viewport.left;
    else if (tab.right > viewport.right) this.scroller.scrollLeft += tab.right - viewport.right;
  }

  focusActive() {
    const target = this.root.querySelector('.tab.active') || this.root.querySelector('.console-launcher');
    target.focus({ preventScroll: true });
  }

  syncOverflow() {
    const viewport = this.scroller;
    if (!viewport) return;
    const controls = this.root.querySelector('.tab-scroll-controls');
    // 将按钮占用的宽度加回，避免临界宽度下按钮反复显示、隐藏。
    const available = viewport.clientWidth + controls.getBoundingClientRect().width;
    controls.hidden = viewport.scrollWidth <= available + SCROLL_TOLERANCE;
    const maximum = viewport.scrollWidth - viewport.clientWidth;
    this.root.querySelector('[data-tab-action="scroll-left"]').disabled = viewport.scrollLeft <= SCROLL_TOLERANCE;
    this.root.querySelector('[data-tab-action="scroll-right"]').disabled = viewport.scrollLeft >= maximum - SCROLL_TOLERANCE;
  }

  onResize() {
    this.syncOverflow();
    this.revealActive();
    this.syncOverflow();
    if (this.listOpen) this.positionList();
  }

  onClick(event) {
    const action = event.target.closest('[data-tab-action]')?.dataset.tabAction;
    if (!action) return;
    event.stopPropagation();
    if (action === 'toggle-list') {
      if (this.listOpen) this.hideList({ restoreFocus: true });
      else this.openList();
      return;
    }
    const direction = action === 'scroll-left' ? -1 : 1;
    const reducedMotion = this.options.window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.scroller.scrollBy({ left: direction * this.scroller.clientWidth * SCROLL_PAGE_RATIO, behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  onWheel(event) {
    if (event.ctrlKey || !event.target.closest('.tabs-scroll')) return;
    const viewport = this.scroller;
    if (viewport.scrollWidth <= viewport.clientWidth + SCROLL_TOLERANCE) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const scale = event.deltaMode === WHEEL_LINE_MODE ? WHEEL_LINE_PIXELS :
      event.deltaMode === WHEEL_PAGE_MODE ? viewport.clientWidth : 1;
    event.preventDefault();
    viewport.scrollLeft += delta * scale;
  }

  onTabKeydown(event) {
    if (!event.target.matches('.tab[role="tab"]') || event.isComposing) return;
    const id = Number(event.target.dataset.id);
    if (event.key === 'Delete') {
      event.preventDefault();
      this.options.closeTab(id);
      this.focusActive();
      return;
    }
    const targetId = tabIdForKey({ ...this.options.getState(), activeTabId: id, key: event.key });
    if (targetId === null) return;
    event.preventDefault();
    this.options.activateTab(targetId);
    this.focusActive();
  }

  openList() {
    this.options.hideMenus();
    this.menu.innerHTML = renderTabListView();
    this.menu.classList.add('show');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.selectedId = this.options.getState().activeTabId;
    this.updateList();
    this.positionList();
    this.input.focus();
    this.revealListSelection();
  }

  hideList(options = {}) {
    const wasOpen = this.listOpen;
    this.menu.classList.remove('show');
    this.trigger?.setAttribute('aria-expanded', 'false');
    if (wasOpen && options.restoreFocus) this.trigger.focus({ preventScroll: true });
  }

  positionList() {
    const rect = this.trigger.getBoundingClientRect();
    const viewport = this.options.window;
    const top = rect.bottom + MENU_GAP;
    const left = Math.max(MENU_MARGIN, Math.min(rect.right - this.menu.offsetWidth, viewport.innerWidth - this.menu.offsetWidth - MENU_MARGIN));
    this.menu.style.left = left + 'px';
    this.menu.style.top = top + 'px';
    this.menu.style.setProperty('--tab-menu-space', (viewport.innerHeight - top - MENU_MARGIN) + 'px');
  }

  matchingTabs() {
    return filterWorkspaceTabs(this.options.getState().tabs, this.input.value);
  }

  updateList() {
    const options = this.viewOptions();
    const tabs = this.matchingTabs();
    if (!tabs.some(tab => tab.id === this.selectedId)) this.selectedId = tabs[0]?.id ?? null;
    this.menu.querySelector('.tab-list-results').innerHTML = renderTabListResults({ ...options, tabs, selectedId: this.selectedId });
    const total = visibleTabs(options.tabs).length;
    this.menu.querySelector('.tab-list-count').textContent = this.input.value.trim() ? `${tabs.length} / ${total}` : `${total}`;
    this.updateListSelection();
  }

  updateListSelection() {
    this.menu.querySelectorAll('[role="option"]').forEach(option => {
      option.setAttribute('aria-selected', String(Number(option.dataset.id) === this.selectedId));
    });
    if (this.selectedId === null) this.input.removeAttribute('aria-activedescendant');
    else this.input.setAttribute('aria-activedescendant', `tab-option-${this.selectedId}`);
  }

  revealListSelection() {
    this.menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  onListClick(event) {
    event.stopPropagation();
    const item = event.target.closest('[data-tab-action]');
    if (item?.dataset.tabAction === 'close-list') this.hideList({ restoreFocus: true });
    if (item?.dataset.tabAction === 'activate-list') this.activateListedTab(Number(item.dataset.id));
  }

  activateListedTab(id) {
    this.hideList();
    this.options.activateTab(id);
    this.focusActive();
  }

  onListKeydown(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.hideList({ restoreFocus: true });
      return;
    }
    if (event.target !== this.input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.selectedId !== null) this.activateListedTab(this.selectedId);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const tabs = this.matchingTabs();
    if (!tabs.length) return;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const index = tabs.findIndex(tab => tab.id === this.selectedId);
    this.selectedId = tabs[(index + direction + tabs.length) % tabs.length].id;
    this.updateListSelection();
    this.revealListSelection();
  }

  dispose() {
    this.events.abort();
    this.resizeObserver.disconnect();
    this.hideList();
  }
}

export function createWorkspaceTabs(options) {
  const tabs = new WorkspaceTabs(options);
  tabs.bind();
  return Object.freeze({
    render: settings => tabs.render(settings),
    hideList: () => tabs.hideList(),
    toggleConsoleMenu: button => showConsoleMenu({ button, ...options.getState(), hideMenus: options.hideMenus }),
    toggleAllConsolesMenu: button => showAllConsolesMenu({ button, ...options.getState() }),
    dispose: () => tabs.dispose(),
  });
}
