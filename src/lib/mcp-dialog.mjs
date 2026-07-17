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
  mask.addEventListener('click', event => {
    const button = event.target.closest('[data-copy-target]');
    if (button) copyValue(byId(button.dataset.copyTarget), options.toast);
  });
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
    description.textContent = name === 'get_table_schema' ? '查询数据库表的字段、索引和 DDL 结构' : 'MCP 工具';
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
