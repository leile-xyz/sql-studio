async function loadSearchTables(node, options) {
  if (!options.isCurrent() || node.tables != null || node.loading) return;
  await options.loadTables(node);
}

async function loadSearchDatabase(database, options) {
  if (!options.isCurrent()) return;
  if (!options.isPostgres(database.dbType)) {
    await loadSearchTables(database, options);
    return;
  }
  if (database.schemas == null && !database.loading) await options.loadSchemas(database);
  if (!options.isCurrent() || !database.schemas) return;
  await Promise.all(database.schemas.map(schema => loadSearchTables(schema, options)));
}

async function loadSearchInstance(instance, options) {
  if (!options.isCurrent()) return;
  if (instance.dbs == null && !instance.loading) await options.loadDbs(instance);
  if (!options.isCurrent() || !instance.dbs) return;
  await Promise.all(instance.dbs.map(database => loadSearchDatabase(database, options)));
}

async function loadTreeData(tree, options) {
  await Promise.all(tree.map(instance => loadSearchInstance(instance, options)));
}

export function createResourceTreeSearch(options) {
  let request = 0;
  let loading = false;
  let error = '';
  let pending = null;

  function getLoad() {
    const tree = options.getTree();
    const origin = options.getOrigin();
    if (!pending || pending.tree !== tree || pending.origin !== origin) {
      const scope = { tree, origin };
      const loadOptions = {
        isCurrent: () => options.getTree() === tree && options.getOrigin() === origin,
        isPostgres: options.isPostgres,
        loadDbs: options.loadDbs,
        loadSchemas: options.loadSchemas,
        loadTables: options.loadTables,
      };
      pending = { ...scope, promise: loadTreeData(tree, loadOptions) };
    }
    return pending.promise;
  }

  async function search() {
    const currentRequest = ++request;
    const filter = options.getFilter();
    error = '';
    loading = !!filter;
    options.render();
    if (!filter) return;
    try {
      await getLoad();
    } catch (loadError) {
      if (currentRequest === request) error = loadError.message;
    }
    if (currentRequest !== request) return;
    loading = false;
    options.render();
  }

  return Object.freeze({
    search,
    viewState: () => Object.freeze({ searchLoading: loading, searchError: error }),
  });
}
