const DEFAULT_SAVE_DELAY_MS = 300;
const DEFAULT_EDITOR_HEIGHT = 172;
const MIGRATED_CONSOLE_KEY = 'console-0';
const MIGRATED_CONSOLE_TITLE = 'console';
const MIGRATED_NEXT_SEQUENCE = 1;

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}格式无效`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label}格式无效`);
  return value;
}

function optionalString(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError(`${label}格式无效`);
  return value;
}

function editorHeight(value) {
  if (value == null) return DEFAULT_EDITOR_HEIGHT;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('控制台编辑器高度格式无效');
  return value;
}

function openState(value) {
  if (value == null) return true;
  if (typeof value !== 'boolean') throw new TypeError('控制台打开状态格式无效');
  return value;
}

function freezeConsole(value) {
  assertRecord(value, '控制台');
  return Object.freeze({
    consoleKey: requiredString(value.consoleKey, '控制台标识'),
    title: requiredString(value.title, '控制台标题'),
    sql: optionalString(value.sql, '控制台 SQL'),
    instance: optionalString(value.instance, '控制台实例'),
    db: optionalString(value.db, '控制台数据库'),
    schema: optionalString(value.schema, '控制台模式'),
    dbType: optionalString(value.dbType, '控制台数据库类型'),
    edH: editorHeight(value.edH),
    open: openState(value.open),
  });
}

function normalizedActiveKey(value, consoles) {
  if (value == null) return null;
  const key = requiredString(value, '活动控制台标识');
  const active = consoles.find(consoleState => consoleState.consoleKey === key);
  if (!active) {
    throw new TypeError('活动控制台不存在');
  }
  if (!active.open) throw new TypeError('活动控制台已关闭');
  return key;
}

function normalizedSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('控制台序号格式无效');
  return value;
}

function freezeSession(value) {
  assertRecord(value, '控制台会话');
  if (!Array.isArray(value.consoles)) throw new TypeError('控制台列表格式无效');
  const consoles = Object.freeze(value.consoles.map(freezeConsole));
  const keys = new Set(consoles.map(consoleState => consoleState.consoleKey));
  if (keys.size !== consoles.length) throw new TypeError('控制台标识重复');
  return Object.freeze({
    consoles,
    activeConsoleKey: normalizedActiveKey(value.activeConsoleKey, consoles),
    nextSequence: normalizedSequence(value.nextSequence),
  });
}

function migratedSession(draft) {
  assertRecord(draft, '旧控制台草稿');
  return freezeSession({
    consoles: [{
      consoleKey: MIGRATED_CONSOLE_KEY,
      title: MIGRATED_CONSOLE_TITLE,
      sql: optionalString(draft.sql, '旧控制台 SQL'),
      instance: optionalString(draft.instance, '旧控制台实例'),
      db: optionalString(draft.db, '旧控制台数据库'),
      schema: optionalString(draft.schema, '旧控制台模式'),
      dbType: optionalString(draft.dbType, '旧控制台数据库类型'),
      edH: DEFAULT_EDITOR_HEIGHT,
      open: true,
    }],
    activeConsoleKey: MIGRATED_CONSOLE_KEY,
    nextSequence: MIGRATED_NEXT_SEQUENCE,
  });
}

function validateOptions(options) {
  assertRecord(options, '控制台会话管理器参数');
  const methods = ['getConsoleSession', 'saveConsoleSession', 'getConsoleDraft'];
  for (const method of methods) {
    if (typeof options.store?.[method] !== 'function') throw new TypeError(`store.${method} 必须是函数`);
  }
  if (typeof options.onError !== 'function') throw new TypeError('onError 必须是函数');
  const delay = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError('saveDelayMs 格式无效');
  return delay;
}

export class ConsoleSessionManager {
  constructor(options) {
    this.saveDelayMs = validateOptions(options);
    this.store = options.store;
    this.onError = options.onError;
    this.pending = new Map();
    this.writeTail = Promise.resolve();
    this.activeWrites = new Set();
  }

  async load(envId) {
    requiredString(envId, '环境标识');
    const stored = await this.store.getConsoleSession(envId);
    if (stored != null) return freezeSession(stored);
    const draft = await this.store.getConsoleDraft(envId);
    if (draft == null) return null;
    const session = migratedSession(draft);
    await this.enqueueSave(envId, session);
    return session;
  }

  schedule(envId, sessionState) {
    requiredString(envId, '环境标识');
    const snapshot = freezeSession(sessionState);
    const previous = this.pending.get(envId);
    if (previous) clearTimeout(previous.timer);
    const entry = { snapshot, timer: null };
    entry.timer = setTimeout(() => this.savePending(envId, entry), this.saveDelayMs);
    this.pending.set(envId, entry);
    return snapshot;
  }

  async flush() {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    const writes = entries.map(([envId, entry]) => {
      clearTimeout(entry.timer);
      return this.enqueueSave(envId, entry.snapshot);
    });
    await Promise.all([...this.activeWrites, ...writes]);
  }

  savePending(envId, entry) {
    if (this.pending.get(envId) !== entry) return;
    this.pending.delete(envId);
    this.enqueueSave(envId, entry.snapshot).catch(this.onError);
  }

  enqueueSave(envId, snapshot) {
    const write = this.writeTail.then(() => this.store.saveConsoleSession(envId, snapshot));
    this.writeTail = write.catch(() => undefined);
    this.activeWrites.add(write);
    write.then(
      () => this.activeWrites.delete(write),
      () => this.activeWrites.delete(write),
    );
    return write;
  }
}
