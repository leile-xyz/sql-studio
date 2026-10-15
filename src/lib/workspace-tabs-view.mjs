import { visibleTabs } from './console-workspace.mjs';

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = value => esc(value).replace(/"/g, '&quot;');
const icon = path => `<svg class="tabbar-icon" viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
const PREVIOUS_ICON = icon('<path d="m10 3-5 5 5 5"/>');
const NEXT_ICON = icon('<path d="m6 3 5 5-5 5"/>');
const LIST_ICON = icon('<path d="M3 4h10M3 8h10M3 12h6"/><path d="m11 11 2 2 2-2"/>');
const SEARCH_ICON = icon('<circle cx="6.8" cy="6.8" r="4.3"/><path d="m10 10 3.5 3.5"/>');
const CLOSE_ICON = icon('<path d="m4 4 8 8M12 4l-8 8"/>');

export function describeWorkspaceTab(tab) {
  const title = tab.type === 'console' ? tab.title : tab.table;
  const database = [tab.db, tab.schema].filter(Boolean).join('.');
  const context = database || tab.instance || '未选择数据源';
  const source = [tab.instance, database].filter(Boolean).join(' / ') || '未选择数据源';
  return Object.freeze({ title, context, source, tooltip: `${title}\n${source}` });
}

export function filterWorkspaceTabs(tabs, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return visibleTabs(tabs).filter(tab => {
    const details = describeWorkspaceTab(tab);
    const text = `${details.title} ${details.source}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

export function tabIdForKey(options) {
  const tabs = visibleTabs(options.tabs);
  const index = tabs.findIndex(tab => tab.id === options.activeTabId);
  if (index < 0) return null;
  if (options.key === 'Home') return tabs[0].id;
  if (options.key === 'End') return tabs.at(-1).id;
  if (options.key === 'ArrowLeft') return tabs[(index + tabs.length - 1) % tabs.length].id;
  if (options.key === 'ArrowRight') return tabs[(index + 1) % tabs.length].id;
  return null;
}

function tabIcon(tab, options) {
  return tab.type === 'console'
    ? `<span class="tab-kind c-idx" aria-hidden="true">${options.consoleIcon}</span>`
    : `<span class="tab-kind c-table" aria-hidden="true">${options.tableIcon}</span>`;
}

function tabHtml(tab, options) {
  const details = describeWorkspaceTab(tab);
  const active = tab.id === options.activeTabId;
  return `<div class="tab${active ? ' active' : ''}" data-act="tab" data-id="${attr(tab.id)}"
    id="workspace-tab-${attr(tab.id)}" role="tab" aria-selected="${active}" aria-controls="tabbody"
    tabindex="${active ? '0' : '-1'}" title="${attr(details.tooltip)}" aria-label="${attr(details.title + '，' + details.source)}">
    ${tabIcon(tab, options)}<span class="tab-label"><span class="tab-title">${esc(details.title)}</span>
      <span class="tab-context">${esc(details.context)}</span></span>
    <button class="x" type="button" tabindex="-1" data-act="close-tab" data-id="${attr(tab.id)}"
      title="关闭标签" aria-label="关闭 ${attr(details.title)}">${CLOSE_ICON}</button></div>`;
}

export function renderTabBarView(options) {
  const tabs = visibleTabs(options.tabs);
  const items = tabs.map(tab => tabHtml(tab, options)).join('');
  return `<div class="console-launcher-wrap">
    <button class="console-launcher" type="button" data-act="toggle-console-menu" title="查询控制台" aria-label="查询控制台">
      ${options.consoleIcon}<span class="launcher-caret">⌄</span>
    </button>
  </div><div class="tabs-scroll" role="tablist" aria-label="工作区标签" aria-orientation="horizontal">
    ${items || '<span class="tabs-empty">打开表或新建查询</span>'}
  </div><div class="tabbar-tools">
    <div class="tab-scroll-controls" hidden>
      <button class="tabbar-button" type="button" data-tab-action="scroll-left" title="向左浏览标签" aria-label="向左浏览标签">${PREVIOUS_ICON}</button>
      <button class="tabbar-button" type="button" data-tab-action="scroll-right" title="向右浏览标签" aria-label="向右浏览标签">${NEXT_ICON}</button>
    </div>
    <button class="tabbar-button tab-list-trigger" type="button" data-tab-action="toggle-list"
      aria-label="已打开的标签，共 ${tabs.length} 个" title="搜索已打开的标签" aria-haspopup="dialog"
      aria-controls="tabListMenu" aria-expanded="false"${tabs.length ? '' : ' disabled'}>
      ${LIST_ICON}<span class="tab-count">${tabs.length}</span>
    </button>
  </div>`;
}

export function renderTabListView() {
  return `<div class="tab-list-heading"><strong>已打开的标签</strong><span class="tab-list-count" role="status" aria-live="polite"></span>
    <button class="tabbar-button" type="button" data-tab-action="close-list" aria-label="关闭标签列表" title="关闭标签列表">${CLOSE_ICON}</button></div>
    <div class="tab-list-search">${SEARCH_ICON}<input id="tabListSearch" type="search" autocomplete="off" spellcheck="false"
      placeholder="搜索表名、数据库或实例…" aria-label="搜索已打开的标签" role="combobox" aria-autocomplete="list"
      aria-controls="tabListResults" aria-expanded="true"></div>
    <div class="tab-list-results" id="tabListResults" role="listbox" aria-label="已打开的标签"></div>
    <div class="tab-list-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 切换</span><span><kbd>Esc</kbd> 关闭</span></div>`;
}

export function renderTabListResults(options) {
  if (!options.tabs.length) return '<div class="tab-list-empty">没有匹配的标签<span>试试表名、数据库或实例名称</span></div>';
  return options.tabs.map(tab => {
    const details = describeWorkspaceTab(tab);
    const active = tab.id === options.activeTabId;
    return `<button class="tab-list-item" type="button" role="option" tabindex="-1" id="tab-option-${attr(tab.id)}"
      data-tab-action="activate-list" data-id="${attr(tab.id)}" aria-selected="${tab.id === options.selectedId}"
      title="${attr(details.tooltip)}">
      ${tabIcon(tab, options)}<span class="tab-list-label"><span class="tab-list-title">${esc(details.title)}</span>
        <span class="tab-list-source">${esc(details.source)}</span></span>${active ? '<span class="tab-current">当前</span>' : ''}</button>`;
  }).join('');
}
