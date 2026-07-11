function requiredTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new Error('请输入控制台名称');
  return title;
}

export function renameConsoleTitle(options) {
  const consoleState = options.consoles.find(item => item.type === 'console' && item.consoleKey === options.consoleKey);
  if (!consoleState) return null;
  // 执行、分页和上下文请求可能仍在回写，重命名必须保留同一个控制台对象。
  consoleState.title = requiredTitle(options.title);
  return consoleState;
}

export class ConsoleRenameController {
  constructor(options) {
    this.options = options;
    this.target = null;
  }

  bind() {
    document.getElementById('renameConsoleCancel').addEventListener('click', () => this.cancel());
    document.getElementById('renameConsoleSubmit').addEventListener('click', () => this.save());
    const input = document.getElementById('renameConsoleInput');
    input.addEventListener('input', () => this.setError(''));
    input.addEventListener('keydown', event => this.handleKeydown(event));
    document.getElementById('renameConsoleMask').addEventListener('click', event => {
      if (event.target.id === 'renameConsoleMask') this.cancel();
    });
  }

  open(tabId) {
    const consoleState = this.options.getConsoles().find(item => item.id === tabId && item.type === 'console');
    if (!consoleState) return;
    this.options.hideMenus();
    this.target = Object.freeze({ envId: this.options.getEnvId(), consoleKey: consoleState.consoleKey });
    const input = document.getElementById('renameConsoleInput');
    input.value = consoleState.title;
    this.setError('');
    this.options.openModal('renameConsoleMask');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  save() {
    if (!this.target) return;
    if (this.target.envId !== this.options.getEnvId()) {
      this.setError('环境已切换，请取消后重新操作');
      return;
    }
    const input = document.getElementById('renameConsoleInput');
    const current = this.options.getConsoles().find(item => item.consoleKey === this.target.consoleKey);
    if (!current) { this.setError('控制台已删除'); return; }
    const previousTitle = current.title;
    let renamed;
    try { renamed = renameConsoleTitle({ consoles: this.options.getConsoles(), consoleKey: this.target.consoleKey, title: input.value }); }
    catch (error) { this.setError(error.message); input.focus(); return; }
    if (!renamed) { this.setError('控制台已删除'); return; }
    if (renamed.title !== previousTitle) { this.options.persist(); this.options.renderTabs(); }
    this.cancel();
  }

  cancel() {
    this.target = null;
    this.setError('');
    this.options.closeModal('renameConsoleMask');
    document.querySelector('[data-act="toggle-console-menu"]')?.focus();
  }

  handleKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault(); event.stopPropagation();
    if (!event.ctrlKey && !event.metaKey) this.save();
  }

  setError(message) {
    document.getElementById('renameConsoleErr').textContent = message;
  }
}
