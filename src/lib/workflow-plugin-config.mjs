const MESSAGE_PLUGIN_KEYS = Object.freeze(['message', 'message_builder']);
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function isMessageBuilder(node) {
  return MESSAGE_PLUGIN_KEYS.includes(node.pluginKey);
}

export function defaultPluginConfig(resource) {
  if (!MESSAGE_PLUGIN_KEYS.includes(resource.pluginKey)) return Object.freeze({});
  return Object.freeze({ format: 'markdown', title: '{{workflow.name}} 执行结果', bodyTemplate: '### {{workflow.name}} 执行结果\n\n{{table}}', emptyBehavior: 'send' });
}

export function renderPluginConfig(node, index) {
  if (!isMessageBuilder(node)) return renderReadonlyConfig(node);
  const config = node.pluginConfig || {};
  return `<div class="workflow-plugin-config"><div class="workflow-plugin-intro">把 SQL 查询结果整理成可读消息，默认以表格展示全部列和数据行。</div><div class="workflow-grid two"><label>消息格式<select data-plugin-format="${index}"><option value="text" ${config.format !== 'markdown' ? 'selected' : ''}>纯文本</option><option value="markdown" ${config.format === 'markdown' ? 'selected' : ''}>Markdown</option></select></label><label>无数据时<select data-plugin-empty="${index}"><option value="send" ${config.emptyBehavior !== 'skip' ? 'selected' : ''}>仍发送</option><option value="skip" ${config.emptyBehavior === 'skip' ? 'selected' : ''}>跳过发送</option></select></label></div><label>消息标题<input data-plugin-title="${index}" maxlength="120" value="${escapeHtml(config.title)}"></label><label>消息内容模板<textarea data-plugin-template="${index}" spellcheck="false">${escapeHtml(config.bodyTemplate || '')}</textarea></label><span class="workflow-config-help">{{table}} 输出完整查询表格；也支持 {{row}}、{{row.field}}、{{object.field}} 和 {{#rows}} 行循环。</span></div>`;
}

function renderReadonlyConfig(node) {
  const config = node.pluginConfig || {};
  const entries = Object.entries(config);
  if (!entries.length) return '<span class="workflow-config-help">此插件无需流程级配置。</span>';
  return `<dl class="workflow-config-summary">${entries.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

export function collectPluginConfig(container, node, index) {
  if (!isMessageBuilder(node)) return node.pluginConfig || {};
  return Object.freeze({
    format: container.querySelector(`[data-plugin-format="${index}"]`).value,
    title: container.querySelector(`[data-plugin-title="${index}"]`).value.trim(),
    bodyTemplate: container.querySelector(`[data-plugin-template="${index}"]`).value,
    emptyBehavior: container.querySelector(`[data-plugin-empty="${index}"]`).value,
  });
}

export function validatePluginConfig(node) {
  if (!isMessageBuilder(node)) return;
  if (!node.pluginConfig?.bodyTemplate?.trim()) throw new Error(`请填写“${node.name}”的消息模板`);
}
