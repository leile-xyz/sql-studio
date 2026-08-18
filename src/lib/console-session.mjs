const DEFAULT_SAVE_DELAY_MS = 300;
const DEFAULT_EDITOR_HEIGHT = 172;
const MIGRATED_CONSOLE_KEY = 'console-0';
const MIGRATED_CONSOLE_TITLE = 'console';
const MIGRATED_NEXT_SEQUENCE = 1;
const UNLOADED_BASELINE = Symbol('unloaded console baseline');

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

function sessionFingerprint(session) {
  return JSON.stringify(session);
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
    this.states = new Map();
    this.writeTail = Promise.resolve();
    this.activeWrites = new Set();
    this.activeEntries = new Map();
    this.flushPromise = null;
    this.changeVersion = 0;
    this.loads = new Map();
  }

  async load(envId) {
    requiredString(envId, '环境标识');
    const existing = this.loads.get(envId);
    if (existing) return existing;
    const loading = this.loadInternal(envId);
    this.loads.set(envId, loading);
    try {
      return await loading;
    } finally {
      if (this.loads.get(envId) === loading) this.loads.delete(envId);
    }
  }

  async loadInternal(envId) {
    const state = this.stateFor(envId);
    const initialRevision = state.revision;
    await this.flush();
    if (state.revision !== initialRevision) return this.finishConcurrentLoad(state, null);
    const readRevision = initialRevision;
    const stored = await this.store.getConsoleSession(envId);
    if (stored != null) {
      const session = freezeSession(stored);
      if (state.revision !== readRevision) return this.finishConcurrentLoad(state, session);
      this.adoptBaseline(state, session);
      return session;
    }
    const draft = await this.store.getConsoleDraft(envId);
    if (state.revision !== readRevision) return this.finishConcurrentLoad(state, null);
    if (draft == null) {
      this.adoptBaseline(state, null);
      return null;
    }
    const session = migratedSession(draft);
    const entry = this.createDesired(state, { envId, snapshot: session });
    await this.enqueueEntry(entry);
    if (state.revision !== entry.revision) return this.finishConcurrentLoad(state, session);
    return session;
  }

  schedule(envId, sessionState) {
    requiredString(envId, '环境标识');
    const state = this.stateFor(envId);
    const snapshot = freezeSession(sessionState);
    const fingerprint = sessionFingerprint(snapshot);
    if (this.sameActiveOrPending(state, fingerprint)) return snapshot;
    if (this.canSkip(state, fingerprint)) {
      state.desired = null;
      state.dirty = false;
      this.cancelPending(state);
      return snapshot;
    }
    const entry = this.createDesired(state, { envId, snapshot, fingerprint });
    state.dirty = true;
    if (this.hasActiveFingerprint(state, fingerprint)) this.cancelPending(state);
    else this.armPending(state, entry);
    return snapshot;
  }

  flush() {
    if (this.flushPromise) return this.flushPromise;
    const worker = this.flushRequests();
    this.flushPromise = worker;
    return worker;
  }

  stateFor(envId) {
    let state = this.states.get(envId);
    if (!state) {
      state = {
        baseline: UNLOADED_BASELINE,
        baselineSnapshot: null,
        desired: null,
        revision: 0,
        pending: null,
        active: new Set(),
        dirty: false,
        lastError: null,
      };
      this.states.set(envId, state);
    }
    return state;
  }

  createDesired(state, { envId, snapshot, fingerprint = sessionFingerprint(snapshot) }) {
    const entry = Object.freeze({ envId, snapshot, fingerprint, revision: state.revision + 1 });
    state.revision = entry.revision;
    state.desired = entry;
    state.dirty = true;
    this.changeVersion += 1;
    return entry;
  }

  sameActiveOrPending(state, fingerprint) {
    return state.desired?.fingerprint === fingerprint
      && (state.pending?.entry.fingerprint === fingerprint || this.hasActiveFingerprint(state, fingerprint));
  }

  hasActiveFingerprint(state, fingerprint) {
    return [...state.active].some(entry => entry.fingerprint === fingerprint);
  }

  canSkip(state, fingerprint) {
    if (state.baseline === UNLOADED_BASELINE || state.baseline !== fingerprint) return false;
    return ![...state.active].some(entry => entry.fingerprint !== fingerprint);
  }

  cancelPending(state) {
    if (!state.pending) return;
    clearTimeout(state.pending.timer);
    state.pending = null;
  }

  armPending(state, entry) {
    this.cancelPending(state);
    const pending = { entry, timer: null };
    pending.timer = setTimeout(() => this.savePending(entry.envId, pending), this.saveDelayMs);
    state.pending = pending;
  }

  savePending(envId, pending) {
    const state = this.stateFor(envId);
    if (state.pending !== pending) return;
    state.pending = null;
    if (!state.dirty || state.desired?.revision !== pending.entry.revision) return;
    this.enqueueEntry(pending.entry).catch(this.onError);
  }

  enqueueEntry(entry) {
    const state = this.stateFor(entry.envId);
    const write = this.writeTail.then(() => this.store.saveConsoleSession(entry.envId, entry.snapshot));
    this.writeTail = write.catch(() => undefined);
    state.active.add(entry);
    const tracked = write.then(
      () => { this.markWriteSuccess(state, entry); },
      error => { this.markWriteFailure(state, entry, error); throw error; },
    );
    this.activeWrites.add(tracked);
    this.activeEntries.set(tracked, entry);
    const cleanup = () => {
      state.active.delete(entry);
      this.activeWrites.delete(tracked);
      this.activeEntries.delete(tracked);
    };
    tracked.then(
      () => { cleanup(); this.scheduleRemaining(state, entry, false); },
      () => { cleanup(); this.scheduleRemaining(state, entry, true); },
    );
    return tracked;
  }

  markWriteSuccess(state, entry) {
    state.baseline = entry.fingerprint;
    state.baselineSnapshot = entry.snapshot;
    state.lastError = null;
    if (state.desired?.revision === entry.revision) state.desired = null;
    state.dirty = !!state.desired && state.desired.fingerprint !== state.baseline;
  }

  markWriteFailure(state, entry, error) {
    state.lastError = error;
    if (!state.desired) state.desired = entry;
    state.dirty = state.baseline === UNLOADED_BASELINE
      || state.desired.fingerprint !== state.baseline;
  }

  scheduleRemaining(state, completed, failed) {
    const desired = state.desired;
    if (!state.dirty || !desired || state.pending || this.hasActiveFingerprint(state, desired.fingerprint)) return;
    if (failed && desired.revision === completed.revision) return;
    this.armPending(state, desired);
  }

  adoptBaseline(state, session) {
    this.cancelPending(state);
    state.baseline = session == null ? null : sessionFingerprint(session);
    state.baselineSnapshot = session;
    state.desired = null;
    state.dirty = false;
    state.lastError = null;
  }

  async finishConcurrentLoad(state, fallback) {
    await this.flush();
    return state.desired?.snapshot || state.baselineSnapshot || fallback;
  }

  collectFlushWrites(attempted) {
    const writes = [];
    for (const state of this.states.values()) {
      this.cancelPending(state);
      const desired = state.desired;
      if (!state.dirty || !desired || this.hasActiveFingerprint(state, desired.fingerprint) || attempted.has(desired)) continue;
      attempted.add(desired);
      writes.push(this.enqueueEntry(desired));
    }
    return writes;
  }

  async flushAll(attempted) {
    let firstError = null;
    let hasError = false;
    let stableVersion = this.changeVersion;
    while (true) {
      const observedVersion = this.changeVersion;
      const active = [...this.activeWrites];
      active.forEach(write => {
        const entry = this.activeEntries.get(write);
        if (entry) attempted.add(entry);
      });
      const writes = this.collectFlushWrites(attempted);
      if (!active.length && !writes.length) {
        await Promise.resolve();
        const pending = [...this.states.values()].some(state => state.pending);
        if (observedVersion === this.changeVersion && !this.activeWrites.size && !pending) {
          stableVersion = observedVersion;
          break;
        }
        continue;
      }
      const results = await Promise.allSettled([...active, ...writes]);
      const failure = results.find(result => result.status === 'rejected');
      if (!hasError && failure) {
        hasError = true;
        firstError = failure.reason;
      }
    }
    return Object.freeze({ stableVersion, hasError, firstError });
  }

  async flushRequests() {
    const attempted = new Set();
    let firstError = null;
    let hasError = false;
    while (true) {
      const result = await this.flushAll(attempted);
      if (!hasError && result.hasError) {
        hasError = true;
        firstError = result.firstError;
      }
      await Promise.resolve();
      if (result.stableVersion === this.changeVersion) break;
    }
    this.flushPromise = null;
    if (hasError) throw firstError;
  }
}
