// What the code may use, per kind of file. No plugin: the rules of ESLint itself, for undefined names,
// dead variables and likely mistakes; style is left alone.
import js from '@eslint/js';

const browser = Object.fromEntries(['window', 'document', 'navigator', 'location', 'localStorage', 'fetch', 'URL', 'URLSearchParams',
    'AbortController', 'AbortSignal', 'DOMParser', 'CSS', 'Intl', 'performance', 'console', 'setTimeout', 'clearTimeout', 'L',
    'getSelection', 'matchMedia', 'Event', 'KeyboardEvent', 'MouseEvent', 'Response', 'atob'].map(name => [name, 'readonly']));
const node = Object.fromEntries(['process', 'console', 'require', 'module', '__dirname', 'URL', 'URLSearchParams', 'fetch', 'Response', 'Buffer',
    'setTimeout', 'clearTimeout', 'globalThis', 'performance', 'AbortSignal', 'AbortController', 'structuredClone', 'FormData', 'Blob', 'WebSocket'].map(name => [name, 'readonly']));
const rules = { 'no-unused-vars': ['error', { ignoreRestSiblings: true, caughtErrors: 'none' }] };

export default [
    { ignores: ['assets/', 'test-results/', 'playwright-report/'] },
    js.configs.recommended,
    { files: ['js/**/*.js'], languageOptions: { sourceType: 'module', globals: browser }, rules },
    // Node scripts; those drive a page too, whose code they only send as text or functions
    { files: ['scripts/**/*.js'], languageOptions: { sourceType: 'commonjs', globals: { ...node, ...browser } }, rules },
    { files: ['scripts/eval/**/*.js', 'scripts/search-queries.js', 'scripts/build-*.js'], languageOptions: { sourceType: 'module' } },
    { files: ['tests/**/*.mjs', '*.mjs'], languageOptions: { sourceType: 'module', globals: { ...node, ...browser } }, rules },
];
