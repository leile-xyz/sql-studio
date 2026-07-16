import { workflowApi } from './workflow-api.mjs';
import { createPluginNode, createWorkflowDraft, isPostgres, normalizeWorkflow, validateWorkflowDraft } from './workflow-model.mjs';
import { bindWorkflowHistory } from './workflow-history.mjs';
import { collectPluginConfig, renderPluginConfig } from './workflow-plugin-config.mjs';
import { bindMessageCenter } from './message-center.mjs';
import { bindWorkflowSchedule, formatScheduleTime, workflowScheduleApi } from './workflow-schedule.mjs';
import { bindWorkflowSqlAutocomplete } from './workflow-sql-autocomplete.mjs';

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const optionHtml = (items, value, label) => items.map(item => `<option value="${esc(value(item))}">${esc(label(item))}</option>`).join('');
const pluginDisplayName = node => node.pluginKey === 'dingtalk' ? '钉钉机器人消息' : node.pluginKey === 'message_builder' ? '消息内容编排' : node.name;
const PLUGIN_PICKER_ORDER = Object.freeze({ message_builder: 0, dingtalk: 1 });

export function bindWorkflowManager({ api, toast, getAppState, workflows = workflowApi, schedules = workflowScheduleApi }) {
  bindMessageCenter({ toast });
  const get = id => document.getElementById(id);
  const state = { items: [], draft: null, resources: [], loading: false };
  const context = Object.freeze({ api, toast, getAppState, workflows, get, state });
  state.history = bindWorkflowHistory(context);
  state.schedule = bindWorkflowSchedule({
    get,
    toast,
    api: schedules,
    onChanged: () => loadList(context, context.state.draft?.id),
  });
  state.sqlAutocomplete = bindWorkflowSqlAutocomplete({
    api,
    get,
    getAppState,
    onError: (message, error) => console.error('[SQL Studio] ' + message, error),
  });
  get('btnWorkflows').addEventListener('click', () => openManager(context));
  get('workflowClose').addEventListener('click', () => { get('workflowPage').hidden = true; });
  get('workflowRefresh').addEventListener('click', () => loadList(context));
  get('workflowNew').addEventListener('click', () => beginCreate(context));
  get('workflowCancelEdit').addEventListener('click', () => showEmpty(context));
  get('workflowSave').addEventListener('click', () => saveDraft(context, false));
  get('workflowPublish').addEventListener('click', () => saveDraft(context, true));
  get('workflowAddPlugin').addEventListener('click', () => addPlugin(context));
  get('workflowPluginPickerClose').addEventListener('click', () => closePluginPicker(context));
  get('workflowPluginPickerList').addEventListener('click', event => choosePlugin(context, event));
  get('workflowList').addEventListener('click', event => selectWorkflow(context, event));
  get('workflowItemActions').addEventListener('click', event => runItemAction(context, event));
  get('workflowNodes').addEventListener('click', event => removeNode(context, event));
  bindSourceEvents(context);
  return Object.freeze({ environmentChanged: () => environmentChanged(context) });
}

async function environmentChanged(context) {
  if (context.get('workflowPage').hidden) return;
  showEmpty(context);
  await loadList(context);
}

async function openManager(context) {
  context.get('workflowPage').hidden = false;
  try {
    const { activeEnvId } = context.getAppState();
    const [items, resources] = await Promise.all([context.workflows.list(activeEnvId), context.workflows.pluginResources()]);
    context.state.items = items || [];
    context.state.resources = (resources || []).filter(resource => resource.enabled !== false && resource.configured);
    renderList(context);
  } catch (error) { context.toast('读取流水线失败：' + error.message, 'err'); }
}

async function loadList(context, selectedId) {
  try {
    context.state.items = await context.workflows.list(context.getAppState().activeEnvId) || [];
    renderList(context, selectedId);
  } catch (error) { context.toast('刷新流水线失败：' + error.message, 'err'); }
}

function renderList(context, selectedId = context.state.draft?.id) {
  const list = context.get('workflowList');
  if (!context.state.items.length) { list.innerHTML = '<div class="workflow-list-empty">暂无流水线</div>'; return; }
  list.innerHTML = context.state.items.map(item => {
    const nextRun = formatScheduleTime(item.enabled ? item.nextRunAt : null, item.scheduleTimezone);
    return `<button class="workflow-list-item ${item.id === selectedId ? 'active' : ''}" data-id="${esc(item.id)}"><strong>${esc(item.name)}</strong><span><b class="workflow-status ${item.enabled ? 'enabled' : ''}">${item.enabled ? '已启用' : '未启用'}</b> · ${item.activeVersionId ? '已发布' : '未发布'}</span><span class="workflow-list-next">下次执行<time>${esc(nextRun)}</time></span></button>`;
  }).join('');
}

async function selectWorkflow(context, event) {
  const item = event.target.closest('[data-id]');
  if (!item) return;
  try {
    context.state.draft = normalizeWorkflow(await context.workflows.get(item.dataset.id));
    renderEditor(context);
    renderList(context, item.dataset.id);
    await Promise.all([loadSourceOptions(context), context.state.history.load(), context.state.schedule.load(context.state.draft)]);
  } catch (error) { context.toast('读取流程详情失败：' + error.message, 'err'); }
}

function beginCreate(context) {
  const { envs, activeEnvId } = context.getAppState();
  context.state.draft = createWorkflowDraft(activeEnvId || envs[0]?.id || '');
  renderEditor(context);
  renderList(context, null);
  context.state.history.clear();
  context.state.schedule.clear();
  loadSourceOptions(context).catch(error => showSourceError(context, error));
}

function renderEditor(context) {
  const { draft } = context.state;
  context.get('workflowEmpty').hidden = true;
  context.get('workflowForm').hidden = false;
  context.get('workflowEditorTitle').textContent = draft.id ? draft.name : '新建流水线';
  context.get('workflowRevision').textContent = draft.id ? `草稿修订 ${draft.expectedDraftRevision}` : '尚未保存';
  context.get('workflowName').value = draft.name;
  context.get('workflowDescription').value = draft.description;
  renderEnvironmentOptions(context);
  renderNodes(context);
  renderItemActions(context);
  context.get('workflowRun').hidden = !draft.id;
  context.get('workflowRun').disabled = !draft.id || !draft.activeVersionId;
  context.get('workflowHistorySection').hidden = !draft.id;
}

function renderEnvironmentOptions(context) {
  const select = context.get('workflowEnvironment');
  const { envs, activeEnvId } = context.getAppState();
  const environment = envs.find(env => env.id === activeEnvId);
  select.innerHTML = environment ? `<option value="${esc(environment.id)}">${esc(environment.name)}</option>` : '';
  select.value = activeEnvId || '';
}

function renderNodes(context) {
  const nodes = context.state.draft.nodes;
  context.get('workflowNodes').innerHTML = nodes.map((node, index) => node.nodeKind === 'sql'
    ? `<article class="workflow-node"><div class="workflow-node-head"><span class="workflow-node-index">${index + 1}</span><strong>SQL 执行</strong></div><div class="workflow-grid two"><label>节点名称<input data-node-name="${index}" value="${esc(node.name)}"></label><label>SQL 类型<select data-sql-kind="${index}"><option value="query" selected>查询（返回数据）</option></select><small class="workflow-field-help">仅支持一条 SELECT、WITH 等查询语句，保存时会进行语法检查。</small></label></div><label>SQL<textarea data-sql="${index}" spellcheck="false">${esc(node.sql)}</textarea></label></article>`
    : `<article class="workflow-node"><div class="workflow-node-head"><span class="workflow-node-index">${index + 1}</span><strong>${esc(pluginDisplayName(node))}</strong><span>${node.terminal ? '消息推送 · 终止节点' : '数据加工'}</span><button class="icon-btn" type="button" data-remove-node="${index}" title="移除">×</button></div><span class="workflow-status">${esc(node.inputType || '任意')} → ${esc(node.outputType)}</span>${renderPluginConfig(node, index)}</article>`).join('');
  context.get('workflowAddPlugin').disabled = nodes.some(node => node.terminal) || !context.state.resources.length;
}

function renderItemActions(context) {
  const draft = context.state.draft;
  const actions = context.get('workflowItemActions');
  actions.innerHTML = draft.id ? `<button class="tbtn" type="button" data-action="copy">复制</button><button class="tbtn" type="button" data-action="toggle">${draft.enabled ? '停用' : '启用'}</button><button class="tbtn danger" type="button" data-action="archive">删除</button>` : '';
  actions.parentElement.hidden = !draft.id;
}

function bindSourceEvents(context) {
  context.get('workflowInstance').addEventListener('change', () => resetSource(context, 'instance'));
  context.get('workflowDatabase').addEventListener('change', () => resetSource(context, 'database'));
}

async function resetSource(context, level) {
  const source = collectSource(context);
  const next = level === 'environment' ? { ...source, instanceId: '', instanceName: '', databaseName: '', databaseType: '', schemaName: null }
    : level === 'instance' ? { ...source, databaseName: '', schemaName: null } : { ...source, schemaName: null };
  context.state.draft = Object.freeze({ ...context.state.draft, dataSource: Object.freeze(next) });
  try { await loadSourceOptions(context); } catch (error) { showSourceError(context, error); }
}

async function loadSourceOptions(context) {
  const source = context.state.draft.dataSource;
  const { activeEnvId, origin } = context.getAppState();
  if (source.environmentId !== activeEnvId) throw new Error('请先在主界面切换并登录所选环境');
  context.get('workflowSourceError').textContent = '';
  const instances = await context.api.instances(origin);
  fillInstances(context, instances, source.instanceId);
  if (!source.instanceId) { clearDatabaseOptions(context); return; }
  const selected = instances.find(item => String(item.id) === String(source.instanceId) || item.instance_name === source.instanceName);
  if (!selected) { clearDatabaseOptions(context); return; }
  const databases = await context.api.databases(origin, selected.instance_name);
  fillDatabases(context, databases, source.databaseName);
  if (!source.databaseName || !isPostgres(selected.db_type)) { toggleSchema(context, false); return; }
  const schemas = await context.api.schemas(origin, { instance: selected.instance_name, db: source.databaseName });
  fillSchemas(context, schemas, source.schemaName);
}

function clearDatabaseOptions(context) {
  fillDatabases(context, [], '');
  toggleSchema(context, false);
}

function fillInstances(context, instances, selectedId) {
  const select = context.get('workflowInstance');
  select.innerHTML = '<option value="">请选择实例</option>' + optionHtml(instances, item => item.id, item => item.instance_name);
  select.value = selectedId || '';
  select.dataset.items = JSON.stringify(instances);
}

function fillDatabases(context, databases, selected) {
  const select = context.get('workflowDatabase');
  select.innerHTML = '<option value="">请选择数据库</option>' + optionHtml(databases, item => item, item => item);
  select.value = selected || '';
}

function fillSchemas(context, schemas, selected) {
  toggleSchema(context, true);
  const select = context.get('workflowSchema');
  select.innerHTML = '<option value="">请选择模式</option>' + optionHtml(schemas, item => item, item => item);
  select.value = selected || '';
}

function toggleSchema(context, visible) {
  const field = context.get('workflowSchemaField');
  field.hidden = !visible;
  field.parentElement.classList.toggle('without-schema', !visible);
}
function showSourceError(context, error) { context.get('workflowSourceError').textContent = error.message; }

function collectSource(context) {
  const instances = JSON.parse(context.get('workflowInstance').dataset.items || '[]');
  const instanceId = context.get('workflowInstance').value;
  const instance = instances.find(item => String(item.id) === instanceId);
  return Object.freeze({
    environmentId: context.get('workflowEnvironment').value,
    instanceId,
    instanceName: instance?.instance_name || '',
    databaseName: context.get('workflowDatabase').value,
    databaseType: instance?.db_type || '',
    schemaName: context.get('workflowSchemaField').hidden ? null : context.get('workflowSchema').value || null,
  });
}

function collectDraft(context) {
  const nodes = collectNodes(context);
  return Object.freeze({ ...context.state.draft, name: context.get('workflowName').value.trim(), description: context.get('workflowDescription').value.trim(), dataSource: collectSource(context), nodes });
}

function collectNodes(context) {
  const nodes = context.state.draft.nodes.map((node, index) => {
    const sqlKind = node.nodeKind === 'sql' ? context.get('workflowNodes').querySelector(`[data-sql-kind="${index}"]`).value : null;
    return Object.freeze({ ...node, position: index,
      name: context.get('workflowNodes').querySelector(`[data-node-name="${index}"]`)?.value.trim() || node.name,
      sql: node.nodeKind === 'sql' ? context.get('workflowNodes').querySelector(`[data-sql="${index}"]`).value : null,
      sqlKind,
      outputType: node.nodeKind === 'sql' ? (sqlKind === 'query' ? 'table' : 'object') : node.outputType,
      pluginConfig: node.nodeKind === 'plugin' ? collectPluginConfig(context.get('workflowNodes'), node, index) : null,
    });
  });
  return Object.freeze(nodes);
}

async function saveDraft(context, publish) {
  try {
    const draft = validateWorkflowDraft(collectDraft(context));
    const result = draft.id ? await context.workflows.update(draft) : await context.workflows.create(draft);
    const workflowId = typeof result === 'string' ? result : result?.id || draft.id;
    const saved = normalizeWorkflow(await context.workflows.get(workflowId));
    if (publish) await context.workflows.publish({ workflowId, expectedDraftRevision: saved.expectedDraftRevision });
    context.toast(publish ? '流水线已发布' : '流水线草稿已保存', 'ok');
    await loadList(context, workflowId);
    context.state.draft = publish ? normalizeWorkflow(await context.workflows.get(workflowId)) : saved;
    renderEditor(context);
    await context.state.schedule.load(context.state.draft);
  } catch (error) { showWorkflowSaveError(context, error); }
}

function showWorkflowSaveError(context, error) {
  const message = error?.message || String(error);
  context.toast('保存失败：' + message, 'err');
  const field = workflowErrorField(context, message);
  field?.scrollIntoView({ block: 'center' });
  field?.focus({ preventScroll: true });
}

function workflowErrorField(context, message) {
  if (/名称/.test(message)) return context.get('workflowName');
  if (/SQL|查询/.test(message)) return context.get('workflowNodes').querySelector('[data-sql="0"]');
  if (/实例/.test(message)) return context.get('workflowInstance');
  if (/数据库/.test(message)) return context.get('workflowDatabase');
  if (/模式/.test(message)) return context.get('workflowSchema');
  return null;
}

function addPlugin(context) {
  context.state.draft = Object.freeze({ ...context.state.draft, nodes: collectNodes(context) });
  const available = context.state.resources
    .filter(resource => !context.state.draft.nodes.some(node => node.pluginResourceId === resource.id))
    .sort((left, right) => (PLUGIN_PICKER_ORDER[left.pluginKey] ?? Number.MAX_SAFE_INTEGER) - (PLUGIN_PICKER_ORDER[right.pluginKey] ?? Number.MAX_SAFE_INTEGER));
  if (!available.length) { context.toast('没有可添加的插件资源', 'err'); return; }
  const list = context.get('workflowPluginPickerList');
  list.innerHTML = available.map(resource => `<button class="workflow-plugin-option" type="button" data-plugin-id="${esc(resource.id)}"><span class="workflow-plugin-option-icon">${resource.pluginKey === 'dingtalk' ? '钉' : '✦'}</span><span><strong>${esc(resource.pluginKey === 'dingtalk' ? '钉钉机器人消息' : resource.pluginKey === 'message_builder' ? '消息内容编排' : resource.name)}</strong><small>${resource.category === 'sink' ? '消息推送 · 终止节点' : '数据加工 · 可继续追加'}</small></span><span class="workflow-plugin-option-arrow">›</span></button>`).join('');
  context.get('workflowPluginMask').hidden = false;
}

function choosePlugin(context, event) {
  const button = event.target.closest('[data-plugin-id]');
  if (!button) return;
  const resource = context.state.resources.find(item => item.id === button.dataset.pluginId);
  if (!resource) return;
  const nodes = Object.freeze([...context.state.draft.nodes, createPluginNode(resource, context.state.draft.nodes.length)]);
  context.state.draft = Object.freeze({ ...context.state.draft, nodes });
  closePluginPicker(context);
  renderNodes(context);
}

function closePluginPicker(context) { context.get('workflowPluginMask').hidden = true; }

function removeNode(context, event) {
  const button = event.target.closest('[data-remove-node]');
  if (!button) return;
  context.state.draft = Object.freeze({ ...context.state.draft, nodes: collectNodes(context) });
  const removeAt = Number(button.dataset.removeNode);
  const nodes = Object.freeze(context.state.draft.nodes.filter((_, index) => index !== removeAt).map((node, position) => Object.freeze({ ...node, position })));
  context.state.draft = Object.freeze({ ...context.state.draft, nodes });
  renderNodes(context);
}

async function runItemAction(context, event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !context.state.draft.id) return;
  try {
    const { id, enabled } = context.state.draft;
    let selectedId = id;
    if (action === 'copy') selectedId = await context.workflows.copy(id);
    if (action === 'toggle') await context.workflows.setEnabled(id, !enabled);
    if (action === 'archive' && !confirm('确定删除该流水线吗？')) return;
    if (action === 'archive') await context.workflows.archive(id);
    if (action === 'archive') { showEmpty(context); await loadList(context); return; }
    context.state.draft = normalizeWorkflow(await context.workflows.get(selectedId));
    renderEditor(context);
    await context.state.schedule.load(context.state.draft);
    await loadList(context, selectedId);
  } catch (error) { context.toast('操作流水线失败：' + error.message, 'err'); }
}

function showEmpty(context) {
  context.state.draft = null;
  context.get('workflowForm').hidden = true;
  context.get('workflowEmpty').hidden = false;
  context.state.schedule.clear();
  renderList(context, null);
}
