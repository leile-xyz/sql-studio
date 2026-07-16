export function bindPluginManager({ api, toast }) {
  const get = id => document.getElementById(id);
  const open = async () => {
    clearForm(get);
    showList(get);
    get('pluginMask').classList.add('show');
    await loadStatus({ api, get });
  };
  get('btnPlugins').addEventListener('click', open);
  get('dingtalkCard').addEventListener('click', () => showDetail(get));
  get('pluginBack').addEventListener('click', () => showList(get));
  get('pluginClose').addEventListener('click', () => get('pluginMask').classList.remove('show'));
  get('dingtalkSave').addEventListener('click', () => saveConfig({ api, toast, get }));
  get('dingtalkDelete').addEventListener('click', () => deleteConfig({ api, toast, get }));
  get('dingtalkTest').addEventListener('click', () => sendTest({ api, toast, get }));
}

async function loadStatus({ api, get }) {
  try {
    const status = await api.dingtalk.status();
    const label = status.configured ? `已配置：${status.maskedWebhook}` : '尚未配置';
    get('dingtalkStatus').textContent = label;
    get('dingtalkCardStatus').textContent = status.configured ? '已配置' : '未配置';
    get('dingtalkCardStatus').classList.toggle('configured', status.configured);
    get('dingtalkStatusBanner').classList.toggle('configured', status.configured);
    get('dingtalkStatusIcon').textContent = status.configured ? '✓' : '—';
    get('dingtalkDelete').disabled = !status.configured;
    get('dingtalkTest').disabled = !status.configured;
  } catch (error) {
    get('dingtalkCardStatus').textContent = '读取失败';
    get('dingtalkStatusIcon').textContent = '!';
    get('dingtalkErr').textContent = error.message;
  }
}

function showList(get) {
  get('pluginList').hidden = false;
  get('dingtalkDetail').hidden = true;
  get('pluginBack').classList.remove('show');
  get('pluginTitle').textContent = '🔌 插件管理';
  get('pluginDesc').textContent = '选择插件查看详情和配置。';
}

function showDetail(get) {
  get('pluginList').hidden = true;
  get('dingtalkDetail').hidden = false;
  get('pluginBack').classList.add('show');
  get('pluginTitle').textContent = '钉钉机器人消息';
  get('pluginDesc').textContent = 'Webhook 与加签密钥保存在 Windows 凭据管理器。';
}

function clearForm(get) {
  get('dingtalkWebhook').value = '';
  get('dingtalkSecret').value = '';
  get('dingtalkMessage').value = 'SQL Studio 钉钉机器人插件测试消息';
  get('dingtalkErr').textContent = '';
}

async function saveConfig({ api, toast, get }) {
  get('dingtalkErr').textContent = '';
  try {
    await api.dingtalk.save(get('dingtalkWebhook').value, get('dingtalkSecret').value);
    toast('钉钉机器人配置已安全保存', 'ok');
    clearSecrets(get);
    await loadStatus({ api, get });
  } catch (error) {
    get('dingtalkErr').textContent = error.message;
  }
}

async function deleteConfig({ api, toast, get }) {
  try {
    await api.dingtalk.remove();
    toast('钉钉机器人配置已删除', 'ok');
    clearSecrets(get);
    await loadStatus({ api, get });
  } catch (error) {
    get('dingtalkErr').textContent = error.message;
  }
}

function clearSecrets(get) {
  get('dingtalkWebhook').value = '';
  get('dingtalkSecret').value = '';
}

async function sendTest({ api, toast, get }) {
  try {
    await api.dingtalk.sendText(get('dingtalkMessage').value);
    toast('钉钉测试消息发送成功', 'ok');
  } catch (error) {
    get('dingtalkErr').textContent = error.message;
  }
}
