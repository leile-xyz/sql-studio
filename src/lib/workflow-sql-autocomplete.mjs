import { SqlAutocomplete } from './sql-editor.mjs';

const WORKFLOW_CONTEXT_TYPE = 'workflow';
const POPUP_ID = 'workflowSqlAutocomplete';

function selectedInstance(get) {
  const select = get('workflowInstance');
  const instances = JSON.parse(select.dataset.items || '[]');
  return instances.find(item => String(item.id) === select.value) || null;
}

export function workflowSqlContext(options) {
  const instance = selectedInstance(options.get);
  const schemaField = options.get('workflowSchemaField');
  return Object.freeze({
    type: WORKFLOW_CONTEXT_TYPE,
    origin: options.getAppState().origin,
    instance: instance?.instance_name || '',
    db: options.get('workflowDatabase').value,
    schema: schemaField.hidden ? '' : options.get('workflowSchema').value,
    dbType: instance?.db_type || '',
  });
}

function isSqlTextarea(target) {
  return target instanceof HTMLTextAreaElement && target.matches('[data-sql]');
}

export function bindWorkflowSqlAutocomplete(options) {
  const container = options.get('workflowNodes');
  const autocomplete = new SqlAutocomplete({
    api: options.api,
    popupId: POPUP_ID,
    getContext: () => workflowSqlContext(options),
    onEditorChange: () => {},
    onWhereChange: () => {},
    onError: options.onError,
  });
  container.addEventListener('input', event => {
    if (isSqlTextarea(event.target)) autocomplete.update(event.target);
  });
  container.addEventListener('keydown', event => {
    if (!autocomplete.isOpenFor(event.target)) return;
    autocomplete.onKeydown(event);
  });
  container.addEventListener('focusout', event => {
    if (!autocomplete.isOpenFor(event.target)) return;
    setTimeout(() => autocomplete.hide(), 100);
  });
  container.addEventListener('scroll', event => {
    if (isSqlTextarea(event.target)) autocomplete.hide();
  }, true);
  container.addEventListener('click', event => {
    if (isSqlTextarea(event.target)) autocomplete.hide();
  });
  return Object.freeze({ hide: () => autocomplete.hide() });
}
