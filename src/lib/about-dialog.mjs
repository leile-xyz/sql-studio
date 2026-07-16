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
  if (!version) return;
  const seenKey = 'sql_studio_seen_update_version';
  if (localStorage.getItem(seenKey) === version) return;
  localStorage.setItem(seenKey, version);
  byId('updateVersion').textContent = 'v' + version;
  byId('updateMask').classList.add('show');
  byId('updateClose').focus();
}

export function bindAboutDialog(options) {
  const mask = byId('aboutMask');
  const close = byId('aboutClose');
  const updateMask = byId('updateMask');
  const updateClose = byId('updateClose');
  byId('btnAbout').addEventListener('click', () => {
    mask.classList.add('show');
    close.focus();
    loadVersion(options);
  });
  close.addEventListener('click', () => mask.classList.remove('show'));
  updateClose.addEventListener('click', () => updateMask.classList.remove('show'));
  showStartupUpdate(options);
}
