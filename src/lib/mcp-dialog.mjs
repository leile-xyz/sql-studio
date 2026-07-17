export function bindMcpDialog(options) {
  const byId = id => document.getElementById(id);
  const mask = byId('mcpMask');
  byId('btnMcp').addEventListener('click', async () => {
    mask.classList.add('show');
    try {
      renderStatus(byId, await options.invoke('mcp_status'));
    } catch (error) {
      renderFailure(byId, error);
    }
  });
  byId('mcpClose').addEventListener('click', () => mask.classList.remove('show'));
  byId('mcpResetToken').addEventListener('click', () => resetToken(byId, options));
  mask.addEventListener('click', event => {
    const button = event.target.closest('[data-copy-target]');
    if (button) copyValue(byId(button.dataset.copyTarget), options.toast);
  });
}

async function resetToken(byId, options) {
  if (!window.confirm('重置后，所有使用旧 Token 的 MCP 客户端都需要更新配置。确定重置吗？')) return;
  const button = byId('mcpResetToken');
  button.disabled = true;
  try {
    renderStatus(byId, await options.invoke('mcp_reset_token'));
    options.toast?.('MCP Access Token 已重置', 'ok');
  } catch (error) {
    renderError(byId('mcpError'), String(error));
    options.toast?.(`重置失败：${error}`, 'err');
  } finally {
    button.disabled = false;
  }
}

function renderStatus(byId, status) {
  const state = byId('mcpState');
  const stateName = status.running ? 'running' : (status.enabled ? 'failed' : 'disabled');
  const stateText = status.running ? '运行中' : (status.enabled ? '启动失败' : '已停用');
  const url = streamableHttpUrl(status);
  state.className = `mcp-state ${stateName}`;
  state.innerHTML = `<i></i>${stateText}`;
  byId('mcpEndpoint').textContent = url || '—';
  byId('mcpToken').textContent = status.token || '—';
  byId('mcpJsonConfig').textContent = formatConfig(url);
  renderTools(byId('mcpTools'), status.tools || []);
  renderError(byId('mcpError'), status.error);
}

function streamableHttpUrl(status) {
  if (!status.endpoint) return '';
  const separator = status.endpoint.includes('?') ? '&' : '?';
  return status.token ? `${status.endpoint}${separator}token=${status.token}` : status.endpoint;
}

function formatConfig(url) {
  if (!url) return '—';
  return JSON.stringify({
    mcpServers: { 'sql-studio': { type: 'streamable-http', url } },
  }, null, 2);
}

function renderTools(container, tools) {
  const descriptions = {
    list_environments: '返回 SQL Studio 已配置的环境',
    list_instances: '返回指定环境可访问的 Archery 实例',
    list_databases: '返回指定实例的数据库',
    list_tables: '返回指定数据库或 schema 的数据表',
    get_table_schema: '返回数据表的字段、索引和 DDL 结构',
  };
  container.replaceChildren();
  if (!tools.length) {
    const empty = document.createElement('span');
    empty.textContent = '暂无可用工具';
    container.append(empty);
    return;
  }
  tools.forEach(name => {
    const item = document.createElement('div');
    item.className = 'mcp-tool';
    const title = document.createElement('code');
    title.textContent = name;
    const description = document.createElement('span');
    description.textContent = descriptions[name] || 'MCP 工具';
    item.append(title, description);
    container.append(item);
  });
}

function renderError(element, error) {
  element.hidden = !error;
  element.textContent = error ? `服务错误：${error}` : '';
}

function renderFailure(byId, error) {
  const state = byId('mcpState');
  state.className = 'mcp-state failed';
  state.innerHTML = '<i></i>读取失败';
  renderError(byId('mcpError'), String(error));
}

async function copyValue(element, toast) {
  const value = element?.textContent?.trim();
  if (!value || value === '—' || value === '读取中…') return;
  try {
    await navigator.clipboard.writeText(value);
    toast?.('已复制到剪贴板', 'ok');
  } catch (error) {
    toast?.(`复制失败：${error.message}`, 'err');
  }
}
