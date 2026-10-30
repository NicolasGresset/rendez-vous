// labels.js - French labels, colors, the duration format and HTML escaping shared by the page's modules

export const MODE_LABELS = { walk: 'marche', bike: 'vélo', car: 'voiture', transit: 'bus/métro' };
export const COLORS = { center: '#0C1A2E' };
// One color per participant (marker and path), none reused for candidates or the chosen place
export const PARTICIPANT_COLORS = ['#2563EB', '#9333EA', '#0D9488', '#DB2777', '#65A30D'];

// 7 min, 1 h 05
export function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

export const escapeHtml = str => String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
