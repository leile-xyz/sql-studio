export function createResourceTreeLoader(dependencies) {
  const { api, getOrigin, makeNode, isPostgres, isCurrentNode, render } = dependencies;
  const canCommit = (node, origin, options) => origin === getOrigin()
    && (!options.isCurrent || options.isCurrent()) && isCurrentNode(node);
  const finishLoad = (node, origin, options) => {
    node.loading = false;
    if (options.render !== false && canCommit(node, origin, options)) render();
  };

  async function loadDbs(node, options = {}) {
    const origin = getOrigin();
    node.loading = true; node.error = ''; if (options.render !== false) render();
    try {
      const dbs = await api.databases(origin, node.name);
      if (canCommit(node, origin, options)) {
        node.dbs = dbs.map(name => makeNode('db', name, {
          inst: node.name, dbType: node.dbType,
          schemas: isPostgres(node.dbType) ? null : [],
          tables: isPostgres(node.dbType) ? [] : null,
        }));
      }
    } catch (error) {
      if (canCommit(node, origin, options)) {
        node.error = error.message; node.dbs = null; node.expanded = true;
      }
    }
    finishLoad(node, origin, options);
  }

  async function loadSchemas(node, options = {}) {
    const origin = getOrigin();
    node.loading = true; node.error = ''; if (options.render !== false) render();
    try {
      const schemas = await api.schemas(origin, { instance: node.inst, db: node.name });
      if (canCommit(node, origin, options)) {
        node.schemas = schemas.map(name => makeNode('schema', name, {
          inst: node.inst, db: node.name, dbType: node.dbType, tables: null,
        }));
      }
    } catch (error) {
      if (canCommit(node, origin, options)) {
        node.error = error.message; node.schemas = null; node.expanded = true;
      }
    }
    finishLoad(node, origin, options);
  }

  async function loadTables(node, options = {}) {
    const origin = getOrigin();
    node.loading = true; node.error = ''; if (options.render !== false) render();
    const db = node.kind === 'schema' ? node.db : node.name;
    const schema = node.kind === 'schema' ? node.name : '';
    try {
      const tables = await api.tables(origin, { instance: node.inst, db, schema });
      if (canCommit(node, origin, options)) {
        node.tables = tables.map(name => makeNode('table', name, {
          inst: node.inst, db, schema, dbType: node.dbType, meta: null,
          open: { cols: false, keys: false, idx: false },
        }));
      }
    } catch (error) {
      if (canCommit(node, origin, options)) {
        node.error = error.message; node.tables = null; node.expanded = true;
      }
    }
    finishLoad(node, origin, options);
  }

  return Object.freeze({ loadDbs, loadSchemas, loadTables });
}
