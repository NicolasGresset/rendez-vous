// map.js - Leaflet drawing on the page's OpenStreetMap map: barycenter, candidates and the
// participants' paths (participant markers stay with the form, in main.js)

import { MODE_LABELS, COLORS, formatDuration, escapeHtml } from './labels.js';

export const TOULOUSE = [43.6045, 1.4440]; // place du Capitole

export function createMap(elementId) {
    const map = L.map(elementId).setView(TOULOUSE, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
}

export function drawCenter(layer, center) {
    L.circleMarker([center.lat, center.lon], { radius: 4, color: COLORS.center, fillOpacity: 1, weight: 1, bubblingMouseEvents: false })
        .bindTooltip('barycentre')
        .addTo(layer);
}

// Candidates. proposals: indices of the best ones, numbered pins from 1; selected: the one shown,
// an orange pin (numbered if a proposal); the others are small grey pins, drawn only when all is
// true (demonstrator view). A click on a marker is not a click on the map (which places the active
// participant)
export function drawCandidates(layer, candidates, categoryLabels, { selected = null, proposals = [], all = true, onSelect = null } = {}) {
    candidates.forEach((c, j) => {
        const isSelected = j === selected;
        const rank = proposals.indexOf(j);
        if (rank < 0 && !isSelected && !all) return;
        const tooltip = `${rank >= 0 ? `${rank + 1}. ` : ''}${escapeHtml(c.name)} · ${categoryLabels[c.category]}`
            + (c.choices ? ` · ${c.score != null ? `trajets ${c.choices.map(choice => formatDuration(choice.travel)).join(', ')}` : 'injoignable'}` : '');
        // Every place is a pin: numbered for the proposals, orange for the chosen one, small and
        // grey for the other candidates. Tip of a pin of size s: s / √2 below its center
        const small = rank < 0 && !isSelected;
        const size = small ? 14 : 26;
        const pinClass = `rank-pin${isSelected ? ' rank-pin--selected' : ''}${small ? ' rank-pin--small' : ''}`;
        const marker = L.marker([c.lat, c.lon], {
            icon: L.divIcon({ className: 'rank-marker', html: `<span class="${pinClass}"><span>${rank >= 0 ? rank + 1 : ''}</span></span>`,
                iconSize: [size, size], iconAnchor: [size / 2, Math.round(size / 2 + size / Math.SQRT2)], tooltipAnchor: [0, -size / 2] }),
            zIndexOffset: isSelected ? 1000 : small ? 0 : 500, keyboard: !!onSelect, title: '',
        });
        marker.bindTooltip(tooltip).addTo(layer);
        if (onSelect && c.score != null && !isSelected) marker.on('click', () => onSelect(j));
    });
}

const straightLine = (from, to, color) => L.polyline([[from.lat, from.lon], [to.lat, to.lon]],
    { color, weight: 2, dashArray: '4 6', opacity: 0.6 });

// A participant's path to the selected place: solid for walk, bike, car and transit lines,
// dotted for walking parts of a transit trip; a straight dashed line until it is known
// group: the participant's layer group, p: the participant, route: its route event (if known)
export function drawRoute(group, p, place, route, color) {
    group.clearLayers();
    if (!route?.legs) {
        const line = straightLine(p, place, color).addTo(group);
        if (route?.error) line.bindTooltip(route.error, { sticky: true });
        return;
    }
    route.legs.forEach(leg => {
        const walking = leg.kind === 'walk' && route.mode === 'transit';
        const label = leg.kind === 'line'
            ? `${p.label} · ${leg.mode || 'ligne'} ${leg.line || ''}`
            : `${p.label} · ${MODE_LABELS[walking ? 'walk' : route.mode]}`;
        if (!leg.path.length) return;
        L.polyline(leg.path, walking
            ? { color, weight: 3, dashArray: '2 6', opacity: 0.9 }
            : { color, weight: 4, opacity: 0.8 })
            .bindTooltip(escapeHtml(label), { sticky: true })
            .addTo(group);
    });
}

// ---- Demonstrator with the local MOTIS (demo-motis.js) ----

// Every enumerated place as a dot colored by how far its score is from the best (green: the best,
// yellow: 50 % worse, red: twice the best or more), and the best 3 as green numbered pins. ranking: indices, best first.
// Drawn on a canvas: thousands of dots stay fluid
export function drawEnumeration(layer, places, ranking, categoryLabels, metricLabel) {
    if (!ranking.length) return;
    const best = places[ranking[0]].score;
    const renderer = L.canvas({ padding: 0.3 });
    [...ranking].reverse().forEach(j => {
        const p = places[j];
        const excess = Math.min(1, (p.score - best) / best);
        const color = `hsl(${Math.round(120 * (1 - excess))} 75% 42%)`;
        const pct = Math.round((p.score / best - 1) * 100);
        L.circleMarker([p.lat, p.lon], { renderer, radius: 3.5, color, weight: 1, fillColor: color, fillOpacity: 0.8,
            bubblingMouseEvents: false })
            .bindTooltip(`${escapeHtml(p.name)} · ${categoryLabels[p.category]} · ${metricLabel} ${formatDuration(p.score)}`
                + ` (${pct ? `+${pct} %` : 'le meilleur'})${p.estimated ? ' · bus/métro estimé' : ''}`)
            .addTo(layer);
    });
    ranking.slice(0, 3).forEach((j, rank) => {
        const p = places[j];
        L.marker([p.lat, p.lon], {
            icon: L.divIcon({ className: 'rank-marker', html: `<span class="rank-pin rank-pin--best"><span>${rank + 1}</span></span>`,
                iconSize: [26, 26], iconAnchor: [13, Math.round(13 + 26 / Math.SQRT2)], tooltipAnchor: [0, -13] }),
            zIndexOffset: 800, keyboard: false, title: '',
        }).bindTooltip(`meilleur n° ${rank + 1} du fichier : ${escapeHtml(p.name)} · ${metricLabel} ${formatDuration(p.score)}`)
            .addTo(layer);
    });
}

// The barycenter's search radius, as engine.js used it
export function drawRadius(layer, center, radius) {
    L.circle([center.lat, center.lon], { radius, color: COLORS.center, weight: 1, dashArray: '4 6', fill: false, interactive: false })
        .addTo(layer);
}

// Transit lines (motis.js networkLines): metro and tram drawn thick, buses thin, in `pane` (under
// the other drawings)
export function drawNetworkLines(layer, lines, pane) {
    const heavy = new Set(['SUBWAY', 'TRAM', 'RAIL', 'AERIAL_LIFT']);
    [...lines].sort((a, b) => heavy.has(a.mode) - heavy.has(b.mode)).forEach(line => {
        L.polyline(line.path, { pane, color: line.color, weight: heavy.has(line.mode) ? 5 : 2,
            opacity: heavy.has(line.mode) ? 0.85 : 0.45, interactive: true })
            .bindTooltip(`${MODE_LABELS.transit} ${escapeHtml(line.names.join(', '))}`, { sticky: true })
            .addTo(layer);
    });
}

// Time map (demo-motis.js timeGrid, scored with scorePlaces): one pixel per cell, stretched (and
// smoothed by the browser) over the grid's box, same colors as the places relative to the grid's
// best cell; cells nobody can reach all stay clear
export function drawTimeGrid(layer, grid) {
    const scores = grid.cells.map(c => c.score).filter(s => s != null);
    if (!scores.length) return;
    const best = Math.min(...scores);
    const canvas = document.createElement('canvas');
    canvas.width = grid.cols;
    canvas.height = grid.rows;
    const context = canvas.getContext('2d');
    grid.cells.forEach((cell, k) => {
        if (cell.score == null) return;
        context.fillStyle = `hsl(${Math.round(120 * (1 - Math.min(1, (cell.score - best) / best)))} 80% 45%)`;
        context.fillRect(k % grid.cols, Math.floor(k / grid.cols), 1, 1);
    });
    L.imageOverlay(canvas.toDataURL(), [[grid.south, grid.west], [grid.north, grid.east]],
        { opacity: 0.45, interactive: false, className: 'time-grid' }).addTo(layer);
}
