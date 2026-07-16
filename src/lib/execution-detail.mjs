const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

const STATUS_LABELS = Object.freeze({
  pending: '等待执行',
  running: '执行中',
  dispatching: '正在推送',
  succeeded: '执行成功',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
  skipped_due_to_failure: '因失败跳过',
});

const TRIGGER_LABELS = Object.freeze({ manual: '手动执行', schedule: '定时执行' });
const ARTIFACT_LABELS = Object.freeze({ table: '查询结果', object: '执行结果', text: '文本结果', message: '消息预览', files: '文件结果', none: '推送结果' });

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function statusName(status) {
  return STATUS_LABELS[status] || status || '未知状态';
}

function statusClass(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? status : 'unknown';
}

function renderStatus(status) {
  return `<span class="execution-status ${statusClass(status)}"><i></i>${escapeHtml(statusName(status))}</span>`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < SECOND_MS) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < MINUTE_MS) return `${(milliseconds / SECOND_MS).toFixed(2)} 秒`;
  const minutes = Math.floor(milliseconds / MINUTE_MS);
  const seconds = Math.round((milliseconds % MINUTE_MS) / SECOND_MS);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function renderTable(artifact) {
  const columns = artifact.columns || artifact.value?.columns || [];
  const rows = artifact.rows || artifact.value?.rows || [];
  if (!columns.length) return '<div class="execution-empty-result">查询没有返回列。</div>';
  const head = columns.map(column => `<th>${escapeHtml(column.name ?? column)}</th>`).join('');
  const body = rows.map(row => {
    const cells = columns.map((column, index) => {
      const key = column.name ?? column;
      const value = Array.isArray(row) ? row[index] : row?.[key];
      return `<td>${escapeHtml(value)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  const empty = rows.length ? body : `<tr><td class="execution-table-empty" colspan="${columns.length}">查询结果为空</td></tr>`;
  return `<div class="execution-table-wrap"><table class="execution-table"><thead><tr>${head}</tr></thead><tbody>${empty}</tbody></table></div>`;
}

function renderMarkdownInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function isTableDivider(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function markdownCells(line, tag) {
  return line.trim().replace(/^\||\|$/g, '').split('|')
    .map(cell => `<${tag}>${renderMarkdownInline(cell.trim())}</${tag}>`).join('');
}

function renderMarkdownTable(lines, start) {
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
    rows.push(`<tr>${markdownCells(lines[cursor], 'td')}</tr>`);
    cursor += 1;
  }
  const head = `<thead><tr>${markdownCells(lines[start], 'th')}</tr></thead>`;
  return { html: `<div class="execution-markdown-table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div>`, next: cursor };
}

function renderMarkdown(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1])) {
      const table = renderMarkdownTable(lines, index);
      blocks.push(table.html); index = table.next; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { blocks.push(`<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    const list = line.match(/^\s*[-*+]\s+(.+)$/);
    if (list) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderMarkdownInline(item[1])}</li>`); index += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`); continue;
    }
    blocks.push(`<p>${renderMarkdownInline(line)}</p>`); index += 1;
  }
  return blocks.join('');
}

function renderMessage(value, artifactIndex) {
  const title = value.title || '消息预览';
  const format = value.format === 'markdown' ? 'Markdown' : '文本';
  const body = value.body || '';
  const content = value.format === 'markdown'
    ? `<div class="execution-markdown">${renderMarkdown(body)}</div>`
    : `<pre class="execution-message-raw">${escapeHtml(body)}</pre>`;
  if (value.format !== 'markdown') return `<div class="execution-message is-plain"><header><div class="execution-message-heading"><div class="execution-message-icon">消</div><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(format)} 消息</span></div></div></header>${content}</div>`;
  const controlId = `execution-message-mode-${artifactIndex}`;
  return `<div class="execution-message"><input class="execution-message-mode" id="${controlId}" type="checkbox"><header><div class="execution-message-heading"><div class="execution-message-icon">消</div><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(format)} 消息</span></div></div><label class="execution-message-mode-button" for="${controlId}"><span class="mode-rendered">查看原始内容</span><span class="mode-raw">返回渲染视图</span></label></header><div class="execution-message-rendered">${content}</div><pre class="execution-message-raw">${escapeHtml(body)}</pre></div>`;
}

function renderArtifactValue(artifact, index) {
  const type = artifact.artifactType || artifact.type;
  const value = artifact.value ?? artifact.data ?? artifact.object ?? {};
  if (type === 'table') return renderTable(artifact);
  if (type === 'message') return renderMessage(value, index);
  if (type === 'none') return `<div class="execution-delivery-result">${escapeHtml(artifact.summary || '推送已完成')}</div>`;
  if (type === 'text') return `<pre class="execution-object">${escapeHtml(value)}</pre>`;
  return `<pre class="execution-object">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderArtifact(artifact, index) {
  const type = artifact.artifactType || artifact.type || 'object';
  const title = artifact.name || ARTIFACT_LABELS[type] || type;
  const meta = [
    artifact.summary,
    Number.isFinite(Number(artifact.rowCount)) ? `${Number(artifact.rowCount)} 行` : '',
    formatBytes(artifact.byteSize),
  ].filter(Boolean).join(' · ');
  return `<section class="execution-artifact"><div class="execution-section-head"><div><span class="execution-section-index">${index + 1}</span><h4>${escapeHtml(title)}</h4></div>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</div>${renderArtifactValue(artifact, index)}</section>`;
}

function renderOverview(detail) {
  const source = detail.dataSource || {};
  const sourceName = [source.instanceName, source.databaseName, source.schemaName].filter(Boolean).join(' / ') || '—';
  const version = detail.versionNumber ? `v${detail.versionNumber}` : '未标记版本';
  const trigger = TRIGGER_LABELS[detail.triggerType] || detail.triggerType || '手动执行';
  const error = detail.errorMessage ? `<div class="execution-error"><strong>${escapeHtml(detail.errorCode || '执行失败')}</strong><span>${escapeHtml(detail.errorMessage)}</span></div>` : '';
  return `<section class="execution-overview"><div class="execution-overview-title"><div><span>执行概览</span><h3>${escapeHtml(detail.workflowName || '流水线执行')}</h3><p>${escapeHtml(version)} · ${escapeHtml(trigger)}</p></div>${renderStatus(detail.status)}</div><dl class="execution-meta-grid"><div><dt>数据源</dt><dd title="${escapeHtml(sourceName)}">${escapeHtml(sourceName)}</dd></div><div><dt>开始时间</dt><dd>${escapeHtml(formatTime(detail.startedAt || detail.createdAt))}</dd></div><div><dt>结束时间</dt><dd>${escapeHtml(formatTime(detail.finishedAt))}</dd></div><div><dt>执行耗时</dt><dd>${escapeHtml(formatDuration(detail.durationMs))}</dd></div></dl>${error}</section>`;
}

function renderNodes(nodes) {
  const items = nodes.map((node, index) => {
    const meta = [node.summary, formatDuration(node.durationMs)].filter(value => value && value !== '—').join(' · ');
    const error = node.errorMessage ? `<div class="execution-node-error">${escapeHtml(node.errorMessage)}</div>` : '';
    return `<article class="execution-node"><span class="execution-node-step">${index + 1}</span><div class="execution-node-content"><div class="execution-node-title"><strong>${escapeHtml(node.nodeName || node.name || `节点 ${index + 1}`)}</strong>${renderStatus(node.status)}</div>${meta ? `<p>${escapeHtml(meta)}</p>` : ''}${error}</div></article>`;
  }).join('');
  const content = items || '<div class="execution-empty-result">暂无节点执行记录。</div>';
  return `<section class="execution-section execution-nodes"><div class="execution-section-head"><div><h4>执行节点</h4><span>按流水线顺序执行</span></div><span>${nodes.length} 个节点</span></div><div class="execution-node-list">${content}</div></section>`;
}

export function renderExecutionDetail(detail) {
  const nodes = detail.nodeExecutions || detail.nodes || [];
  const artifacts = detail.artifacts || [];
  const outputs = artifacts.map(renderArtifact).join('') || '<div class="execution-empty-result">暂无可查看的执行产物。</div>';
  return `<div class="execution-detail">${renderOverview(detail)}${renderNodes(nodes)}<section class="execution-section execution-outputs"><div class="execution-section-head"><div><h4>执行产物</h4><span>查询结果、加工内容与推送回执</span></div><span>${artifacts.length} 项产物</span></div><div class="execution-artifact-list">${outputs}</div></section></div>`;
}
