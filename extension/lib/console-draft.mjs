const DEFAULT_SAVE_DELAY_MS = 300;

export class ConsoleDraftManager {
  constructor(options) {
    this.store = options.store;
    this.onError = options.onError;
    this.saveDelayMs = options.saveDelayMs || DEFAULT_SAVE_DELAY_MS;
    this.timer = null;
  }

  async load(envId) {
    return this.store.getConsoleDraft(envId);
  }

  schedule(envId, consoleState) {
    const draft = Object.freeze({
      sql: consoleState.sql,
      instance: consoleState.instance || '',
      db: consoleState.db || '',
      schema: consoleState.schema || '',
      dbType: consoleState.dbType || '',
      updatedAt: Date.now(),
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.store.saveConsoleDraft(envId, draft).catch(this.onError);
    }, this.saveDelayMs);
    return draft;
  }
}
