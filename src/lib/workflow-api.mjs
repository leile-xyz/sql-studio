function invoke(command, args = {}) {
  return window.__TAURI__.core.invoke(command, args).catch(error => {
    throw new Error(typeof error === 'string' ? error : error?.message || '流水线请求失败');
  });
}

export const workflowApi = Object.freeze({
  list: environmentId => invoke('workflow_list', { environmentId }),
  get: workflowId => invoke('workflow_get', { workflowId }),
  create: input => invoke('workflow_create', { input }),
  update: input => invoke('workflow_update', { input: { ...input, workflowId: input.workflowId || input.id } }),
  copy: workflowId => invoke('workflow_copy', { workflowId }),
  archive: workflowId => invoke('workflow_archive', { workflowId }),
  setEnabled: (workflowId, enabled) => invoke('workflow_set_enabled', { input: { workflowId, enabled } }),
  publish: input => invoke('workflow_publish', { input }),
  pluginResources: () => invoke('workflow_plugin_resources'),
  runManual: input => invoke('run_workflow_manual', { input }),
  executions: workflowId => invoke('list_workflow_executions', { workflowId }),
  execution: executionId => invoke('get_workflow_execution', { executionId }),
});
