import { splitSql } from './sql-editor.mjs';

export function createWorkflowDraft(environmentId = '') {
  return Object.freeze({
    id: null,
    expectedDraftRevision: null,
    name: '',
    description: '',
    enabled: false,
    dataSource: Object.freeze({ environmentId, instanceId: '', instanceName: '', databaseName: '', databaseType: '', schemaName: null }),
    nodes: Object.freeze([createSqlNode()]),
  });
}

export function createSqlNode(source = {}) {
  return Object.freeze({
    id: source.id || crypto.randomUUID(),
    position: 0,
    nodeKind: 'sql',
    name: source.name || '执行 SQL',
    pluginResourceId: null,
    pluginKey: null,
    category: 'sql',
    terminal: false,
    inputType: null,
    outputType: source.outputType || 'table',
    sql: source.sql || '',
    sqlKind: source.sqlKind || 'query',
  });
}

import { defaultPluginConfig, validatePluginConfig } from './workflow-plugin-config.mjs';

export function createPluginNode(resource, position) {
  const displayName = resource.pluginKey === 'dingtalk' ? '钉钉机器人消息' : resource.pluginKey === 'message_builder' ? '消息内容编排' : resource.name;
  return Object.freeze({
    id: crypto.randomUUID(),
    position,
    nodeKind: 'plugin',
    name: displayName,
    pluginResourceId: resource.id,
    pluginKey: resource.pluginKey,
    category: resource.category,
    terminal: Boolean(resource.terminal),
    inputType: resource.inputType || null,
    outputType: resource.outputType || 'none',
    sql: null,
    sqlKind: null,
    pluginConfig: defaultPluginConfig(resource),
  });
}

export function normalizeWorkflow(raw) {
  const dataSource = raw.dataSource || raw.data_source || {};
  const nodes = (raw.nodes || []).map((node, index) => Object.freeze({
    ...node,
    position: index,
    pluginResourceId: node.pluginResourceId ?? null,
    pluginKey: node.pluginKey ?? null,
    inputType: node.inputType ?? null,
    sql: node.sql ?? '',
    sqlKind: node.sqlKind ?? (node.nodeKind === 'sql' ? 'query' : null),
    pluginConfig: Object.freeze(node.pluginConfig || {}),
  }));
  return Object.freeze({
    ...raw,
    expectedDraftRevision: raw.draftRevision ?? raw.expectedDraftRevision ?? 0,
    description: raw.description || '',
    enabled: Boolean(raw.enabled),
    dataSource: Object.freeze({ ...dataSource, schemaName: dataSource.schemaName || null }),
    nodes: Object.freeze(nodes.length ? nodes : [createSqlNode()]),
  });
}

export function validateWorkflowDraft(draft) {
  if (!draft.name.trim()) throw new Error('请输入流水线名称');
  const source = draft.dataSource;
  if (!source.environmentId) throw new Error('请选择当前环境');
  if (!source.instanceId) throw new Error('请选择实例');
  if (!source.databaseName) throw new Error('请选择数据库');
  if (isPostgres(source.databaseType) && !source.schemaName) throw new Error('PostgreSQL 数据源必须选择模式');
  const sqlNode = draft.nodes[0];
  if (!sqlNode || sqlNode.nodeKind !== 'sql' || !sqlNode.sql.trim()) throw new Error('请输入需要执行的 SQL');
  const statements = splitSql(sqlNode.sql, { dbType: source.databaseType });
  if (statements.length !== 1) throw new Error('SQL 节点只能输入一条查询语句');
  if (sqlNode.sqlKind !== 'query') throw new Error('SQL 节点仅允许查询类型');
  const terminalIndex = draft.nodes.findIndex(node => node.terminal);
  if (terminalIndex >= 0 && terminalIndex !== draft.nodes.length - 1) throw new Error('终止插件必须是最后一个节点');
  draft.nodes.filter(node => node.nodeKind === 'plugin').forEach(validatePluginConfig);
  return draft;
}

export const isPostgres = databaseType => /postgres|pgsql/i.test(databaseType || '');
