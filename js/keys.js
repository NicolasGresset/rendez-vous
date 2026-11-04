// keys.js - The page's settings, stored only in this browser (localStorage, never sent to the site).
// Storage may be unavailable (private mode, blocked site data): they then only last for the page's lifetime.

// View, score, candidates, transit engine; {} if none
const SETTINGS_KEY = 'location.settings';
let memorySettings = {};

export function loadSettings() {
    try {
        memorySettings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
        // keep the in-memory settings
    }
    return { ...memorySettings };
}

export function saveSettings(settings) {
    memorySettings = { ...settings };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(memorySettings));
    } catch {
        // kept for the page's lifetime only
    }
}
