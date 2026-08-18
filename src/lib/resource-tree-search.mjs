async function settleLoads(loads) {
  const results = await Promise.allSettled(loads);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function loadNode(node, loader, options) {
  try {
    await loader(node, options.isScopeCurrent);
  } catch (error) {
    options.onError(error);
    throw error;
  }
  options.onLoaded(node);
}

async function loadSearchTables(node, options) {
  if (!options.isCurrent() || node.tables != null || node.loading) return;
  await loadNode(node, options.loadTables, options);
}

async function loadSearchDatabase(database, options) {
  if (!options.isCurrent()) return;
  if (!options.isPostgres(database.dbType)) {
    await loadSearchTables(database, options);
    return;
  }
  if (database.schemas == null && !database.loading) {
    await loadNode(database, options.loadSchemas, options);
  }
  if (!options.isCurrent() || !database.schemas) return;
  await settleLoads(database.schemas.map(schema => loadSearchTables(schema, options)));
}

async function loadSearchInstance(instance, options) {
  if (!options.isCurrent()) return;
  if (instance.dbs == null && !instance.loading) {
    await loadNode(instance, options.loadDbs, options);
  }
  if (!options.isCurrent() || !instance.dbs) return;
  await settleLoads(instance.dbs.map(database => loadSearchDatabase(database, options)));
}

async function loadTreeData(tree, options) {
  await settleLoads(tree.map(instance => loadSearchInstance(instance, options)));
}

export function createResourceTreeSearch(options) {
  let request = 0;
  let loading = false;
  let error = '';
  let pending = null;

  function isCurrentLoad(load) {
    return pending === load
      && load.request === request
      && options.getTree() === load.tree
      && options.getOrigin() === load.origin
      && !!options.getFilter();
  }

  function isCurrentScope(load) {
    return pending === load
      && options.getTree() === load.tree
      && options.getOrigin() === load.origin;
  }

  function isCurrentSearch(currentRequest, scope) {
    return currentRequest === request
      && options.getTree() === scope.tree
      && options.getOrigin() === scope.origin
      && options.getFilter() === scope.filter;
  }

  function scheduleErrorRender(load, loadError) {
    if (!isCurrentLoad(load)) return;
    if (loadError) error = loadError.message;
    if (load.errorRenderScheduled) return;
    load.errorRenderScheduled = true;
    queueMicrotask(() => {
      load.errorRenderScheduled = false;
      if (isCurrentLoad(load)) options.render();
    });
  }

  function startLoad(tree, origin, currentRequest) {
    const load = {
      tree, origin, request: currentRequest, running: true, complete: false, errorRenderScheduled: false,
    };
    pending = load;
    const loadOptions = {
      isCurrent: () => isCurrentLoad(load),
      isScopeCurrent: () => isCurrentScope(load),
      isPostgres: options.isPostgres,
      loadDbs: options.loadDbs,
      loadSchemas: options.loadSchemas,
      loadTables: options.loadTables,
      onError: loadError => scheduleErrorRender(load, loadError),
      onLoaded: node => { if (node.error) scheduleErrorRender(load); },
    };
    load.promise = loadTreeData(tree, loadOptions)
      .then(() => { load.complete = isCurrentLoad(load); })
      .finally(() => {
        load.running = false;
      });
    return load.promise;
  }

  function getLoad(currentRequest, scope) {
    const { tree, origin } = scope;
    const sameScope = pending && pending.tree === tree && pending.origin === origin;
    if (sameScope && pending.running) {
      pending.request = currentRequest;
      return pending.promise;
    }
    if (sameScope && pending.complete) return pending.promise;
    return startLoad(tree, origin, currentRequest);
  }

  async function search() {
    const currentRequest = ++request;
    const scope = {
      tree: options.getTree(), origin: options.getOrigin(), filter: options.getFilter(),
    };
    const { filter } = scope;
    error = '';
    loading = !!filter;
    options.render();
    if (!filter) {
      const activeLoad = pending && pending.running
        && pending.tree === scope.tree && pending.origin === scope.origin ? pending : null;
      if (activeLoad) {
        try {
          await activeLoad.promise;
        } catch (loadError) {
          if (activeLoad.request === currentRequest) error = loadError.message;
        }
        if (isCurrentSearch(currentRequest, scope)) options.render();
      }
      return;
    }
    try {
      await getLoad(currentRequest, scope);
    } catch (loadError) {
      if (isCurrentSearch(currentRequest, scope)) error = loadError.message;
    }
    if (!isCurrentSearch(currentRequest, scope)) return;
    loading = false;
    options.render();
  }

  return Object.freeze({
    search,
    viewState: () => Object.freeze({ searchLoading: loading, searchError: error }),
  });
}
