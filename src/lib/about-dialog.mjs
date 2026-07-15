const byId = id => document.getElementById(id);

async function loadVersion(options) {
  try { byId('aboutVersion').textContent = 'v' + await options.api.appVersion(); }
  catch (error) {
    byId('aboutVersion').textContent = '版本读取失败';
    options.toast('读取版本失败：' + error.message, 'err');
  }
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
}
