import assert from 'node:assert/strict';
import { DARK_THEME, LIGHT_THEME, nextTheme, resolveTheme } from '../src/lib/theme.mjs';

assert.equal(resolveTheme(undefined), LIGHT_THEME);
assert.equal(resolveTheme('invalid'), LIGHT_THEME);
assert.equal(resolveTheme(DARK_THEME), DARK_THEME);
assert.equal(nextTheme(LIGHT_THEME), DARK_THEME);
assert.equal(nextTheme(DARK_THEME), LIGHT_THEME);

console.log('PASS  theme: light default and theme switching');
