import { isPostgresType } from './db-context.mjs';
import { ICO } from './icons.mjs';

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const escapeAttribute = value => escapeHtml(value).replace(/"/g, '&quot;');

function rowHtml(options) {
  const { nodeMap, depth, uid, twist, icon, label, extra = '', act = 'toggle', data = '', busy = false, cls = '' } = options;
  const node = uid ? nodeMap.get(uid) : null;
  const marker = busy
    ? '<span class="twist busy">◠</span>'
    : twist
      ? `<span class="twist ${node && node.expanded ? 'open' : ''}">▶</span>`
      : '<span class="twist leaf"></span>';
  return `<div class="tnode ${cls}" style="padding-left:${8 + depth * 15}px" data-act="${act}" ${uid ? `data-uid="${uid}"` : ''} ${data}>
    ${marker}${icon}<span>${label}</span>${extra}</div>`;
}

function errorRow(depth, message) {
  return `<div class="tnode" style="padding-left:${8 + depth * 15}px"><span class="twist leaf"></span><span class="err">⚠ ${escapeHtml(message)}</span></div>`;
}

function renderTableChildren(table, tableDepth) {
  const metadata = table.meta;
  const folderPadding = 8 + (tableDepth + 1) * 15;
  const itemPadding = 8 + (tableDepth + 3) * 15;
  let html = `<div class="tnode" style="padding-left:${folderPadding}px" data-act="folder" data-uid="${table.uid}" data-fold="cols"><span class="twist ${table.open.cols ? 'open' : ''}">▶</span><span class="c-folder">${ICO.folder}</span><span>列</span><span class="cnt">${metadata.columns.length}</span></div>`;
  if (table.open.cols) for (const column of metadata.columns) {
    const title = column.name + ' · ' + column.type + (column.comment ? '\n' + column.comment : '');
    html += `<div class="tnode" style="padding-left:${itemPadding}px" title="${escapeAttribute(title)}"><span class="twist leaf"></span><span class="${column.pk ? 'c-key' : 'c-col'}">${column.pk ? ICO.key : ICO.col}</span><span>${escapeHtml(column.name)}</span><span class="typ">${escapeHtml(column.type)}${column.ai ? ' (auto)' : ''}</span></div>`;
  }
  const keys = metadata.indexes.filter(index => index.name === 'PRIMARY');
  html += `<div class="tnode" style="padding-left:${folderPadding}px" data-act="folder" data-uid="${table.uid}" data-fold="keys"><span class="twist ${table.open.keys ? 'open' : ''}">▶</span><span class="c-folder">${ICO.folder}</span><span>键</span><span class="cnt">${keys.length}</span></div>`;
  if (table.open.keys) for (const key of keys) {
    html += `<div class="tnode" style="padding-left:${itemPadding}px"><span class="twist leaf"></span><span class="c-key">${ICO.key}</span><span>${escapeHtml(key.name)}</span><span class="typ">(${escapeHtml(key.cols.join(', '))})</span></div>`;
  }
  html += `<div class="tnode" style="padding-left:${folderPadding}px" data-act="folder" data-uid="${table.uid}" data-fold="idx"><span class="twist ${table.open.idx ? 'open' : ''}">▶</span><span class="c-folder">${ICO.folder}</span><span>索引</span><span class="cnt">${metadata.indexes.length}</span></div>`;
  if (table.open.idx) for (const index of metadata.indexes) {
    html += `<div class="tnode" style="padding-left:${itemPadding}px"><span class="twist leaf"></span><span class="c-idx">${ICO.idx}</span><span>${escapeHtml(index.name)}</span><span class="typ">${index.unique ? 'unique' : ''} (${escapeHtml(index.cols.join(', '))})</span></div>`;
  }
  return html;
}

function renderTableNodes(nodeMap, container, depth) {
  if (container.tables == null) return '';
  if (!container.tables.length) {
    return `<div class="tnode" style="padding-left:${8 + depth * 15}px;color:var(--text-faint)"><span class="twist leaf"></span>（无表）</div>`;
  }
  let html = '';
  for (const table of container.tables) {
    html += rowHtml({
      nodeMap,
      depth,
      uid: table.uid,
      twist: true,
      busy: table.loading,
      icon: `<span class="c-table">${ICO.table}</span>`,
      label: escapeHtml(table.name),
      data: 'data-table="1"',
    });
    if (!table.expanded || table.meta == null) {
      if (table.expanded && table.error) html += errorRow(depth + 1, table.error);
      continue;
    }
    html += renderTableChildren(table, depth);
  }
  return html;
}

function renderSearch(tree, filter, nodeMap, loading, searchError) {
  const matches = [];
  const errors = searchError ? [searchError] : [];
  for (const instance of tree) {
    if (!instance.dbs) {
      if (instance.error) errors.push(instance.name + '：' + instance.error);
      continue;
    }
    for (const database of instance.dbs) {
      if (database.error) errors.push(database.name + '：' + database.error);
      if (database.name.toLowerCase().includes(filter)) matches.push({ kind: 'database', node: database, context: instance.name });
      const containers = isPostgresType(database.dbType) ? (database.schemas || []) : [database];
      for (const container of containers) {
        if (!container.tables) {
          if (container.error) errors.push(container.name + '：' + container.error);
          continue;
        }
        for (const table of container.tables) {
          if (table.name.toLowerCase().includes(filter)) matches.push({ kind: 'table', node: table });
        }
      }
    }
  }
  if (!matches.length && loading) return '<div class="tree-msg"><span class="spinner" style="display:inline-block;vertical-align:-4px"></span> 正在加载数据库和数据表…</div>';
  const errorHtml = errors.length ? `<div class="tree-msg">资源加载失败：${escapeHtml(errors.join('；'))}</div>` : '';
  if (!matches.length) return errorHtml + '<div class="tree-msg">数据库和数据表中无匹配</div>';
  const pattern = new RegExp('(' + filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i');
  return errorHtml + matches.map(match => {
    const node = match.node;
    const label = escapeHtml(node.name).replace(pattern, '<mark>$1</mark>');
    if (match.kind === 'database') return rowHtml({
      nodeMap,
      depth: 0,
      uid: node.uid,
      twist: true,
      busy: node.loading,
      icon: `<span class="c-db">${ICO.db}</span>`,
      label,
      extra: `<span class="typ">${escapeHtml(match.context)}</span>`,
      data: `title="${escapeAttribute(match.context)}"`,
    });
    const context = node.schema ? node.db + '.' + node.schema : node.db;
    return `<div class="tnode" style="padding-left:12px" data-act="open-table" data-uid="${node.uid}"><span class="twist leaf"></span><span class="c-table">${ICO.table}</span><span>${label}</span><span class="typ">${escapeHtml(context)}</span></div>`;
  }).join('');
}

export function renderResourceTree(options) {
  if (options.connecting) {
    return `<div class="tree-msg"><span class="spinner" style="display:inline-block;vertical-align:-4px"></span> 正在连接 ${escapeHtml(options.envName)}…</div>`;
  }
  if (!options.connected) {
    const error = options.errorMessage ? '连接失败：' + escapeHtml(options.errorMessage) + '<br><br>' : '';
    return `<div class="tree-msg">${error}未连接到 <b>${escapeHtml(options.envName)}</b>。<br><a data-act="relogin">点此登录</a></div>`;
  }
  if (options.filter) return renderSearch(options.tree, options.filter, options.nodeMap, options.searchLoading, options.searchError);
  const selection = options.selection;
  let html = '';
  for (const instance of options.tree) {
    const instanceSelected = selection && selection.inst === instance.name;
    html += rowHtml({
      nodeMap: options.nodeMap,
      depth: 0,
      uid: instance.uid,
      twist: true,
      busy: instance.loading,
      icon: `<span class="c-server">${ICO.server}</span>`,
      label: escapeHtml(instance.name),
      extra: `<span class="typ">${escapeHtml(instance.dbType || 'mysql')}</span>`,
      cls: instanceSelected && !selection.db ? 'selected' : '',
    });
    if (!instance.expanded) continue;
    if (instance.error) { html += errorRow(1, instance.error); continue; }
    if (instance.dbs == null) continue;
    for (const database of instance.dbs) {
      const databaseSelected = instanceSelected && selection.db === database.name;
      html += rowHtml({
        nodeMap: options.nodeMap,
        depth: 1,
        uid: database.uid,
        twist: true,
        busy: database.loading,
        icon: `<span class="c-db">${ICO.db}</span>`,
        label: escapeHtml(database.name),
        cls: databaseSelected && !selection.schema ? 'selected' : '',
      });
      if (!database.expanded) continue;
      if (database.error) { html += errorRow(2, database.error); continue; }
      if (!isPostgresType(database.dbType)) {
        html += renderTableNodes(options.nodeMap, database, 2);
        continue;
      }
      if (database.schemas == null) continue;
      if (!database.schemas.length) {
        html += '<div class="tnode" style="padding-left:38px;color:var(--text-faint)"><span class="twist leaf"></span>（无模式）</div>';
        continue;
      }
      for (const schema of database.schemas) {
        html += rowHtml({
          nodeMap: options.nodeMap,
          depth: 2,
          uid: schema.uid,
          twist: true,
          busy: schema.loading,
          icon: `<span class="c-folder">${ICO.folder}</span>`,
          label: escapeHtml(schema.name),
          cls: databaseSelected && selection.schema === schema.name ? 'selected' : '',
        });
        if (!schema.expanded) continue;
        if (schema.error) { html += errorRow(3, schema.error); continue; }
        html += renderTableNodes(options.nodeMap, schema, 3);
      }
    }
  }
  return html || '<div class="tree-msg">无实例</div>';
}
