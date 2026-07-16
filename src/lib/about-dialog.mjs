const byId = id => document.getElementById(id);

async function loadVersion(options) {
  try {
    const version = await options.api.appVersion();
    byId('aboutVersion').textContent = 'v' + version;
    return version;
  }
  catch (error) {
    byId('aboutVersion').textContent = '版本读取失败';
    options.toast('读取版本失败：' + error.message, 'err');
    return null;
  }
}

async function showStartupUpdate(options) {
  const version = await loadVersion(options);
  if (version) options.toast(`SQL Studio 已更新到 v${version}：新增流水线编排、定时计划、执行历史和消息中心；支持插件通知与 SQL 强校验。`, 'ok');
}

export function bindAboutDialog(options) {
  const mask = byId('aboutMask');
  const close = byId('aboutClose');
  byId('btnAbout').addEventListener('click', () => {
    mask.classList.add('show');
    close.focus();
    loadVersion(options);
  });
  close.addEventListener('click', () => mask.classList.remove('show'));
  showStartupUpdate(options);
}
