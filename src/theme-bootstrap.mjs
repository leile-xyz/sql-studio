import { bindThemeToggle } from './lib/theme.mjs';

bindThemeToggle({
  root: document.documentElement,
  button: document.getElementById('btnTheme'),
  storage: window.localStorage,
});
