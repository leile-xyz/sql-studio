export const THEME_STORAGE_KEY = 'sql-studio.theme';
export const LIGHT_THEME = 'light';
export const DARK_THEME = 'dark';

export function resolveTheme(value) {
  return value === DARK_THEME ? DARK_THEME : LIGHT_THEME;
}

export function nextTheme(theme) {
  return resolveTheme(theme) === LIGHT_THEME ? DARK_THEME : LIGHT_THEME;
}

function updateToggle(button, theme) {
  const isLight = theme === LIGHT_THEME;
  const label = isLight ? '切换为深色主题' : '切换为浅色主题';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.querySelector('.theme-glyph').textContent = isLight ? '☾' : '☀';
}

export function bindThemeToggle({ root, button, storage }) {
  let theme = resolveTheme(storage.getItem(THEME_STORAGE_KEY));

  const applyTheme = value => {
    theme = resolveTheme(value);
    root.dataset.theme = theme;
    storage.setItem(THEME_STORAGE_KEY, theme);
    updateToggle(button, theme);
  };

  applyTheme(theme);
  button.addEventListener('click', () => applyTheme(nextTheme(theme)));

  return Object.freeze({
    getTheme: () => theme,
    setTheme: applyTheme,
  });
}
