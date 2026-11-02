// build-zones.js - Last step of scripts/regenerate-places.sh: groups the bars of
// data/pois-toulouse.json into zones of bars within a short walk of each other, and rewrites the
// file with each bar's `zone` (an index in the new top-level table `zones`). Rules: docs/pipeline.md § 6.
// Network: none; can be run alone on the current file (it replaces any previous zones).
// Usage: node scripts/build-zones.js [maximum diameter in meters]

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const ZONE_DIAMETER_M = 300; // no two bars of a zone further apart than this
const ZONE_CATEGORIES = new Set(['amenity=bar']);
const STOP_CATEGORIES = new Set(['metro', 'bus']);

// Great-circle distance in meters
function distanceM(a, b) {
    const rad = deg => deg * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const centroid = group => ({
    lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
    lon: group.reduce((s, p) => s + p.lon, 0) / group.length,
});

// Complete linkage: starting from one group per place, merges the two groups whose merged diameter
// is the smallest, as long as it stays within diameter. Unlike chaining places close to each other,
// it cannot run away along a street of bars. Lone places stay groups of one. Reproducible: ties go
// to the first groups, in the file's order
function clusterPlaces(places, diameter) {
    const groups = places.map(p => [p]);
    const mergedDiameter = (a, b) => Math.max(...a.flatMap(x => b.map(y => distanceM(x, y))));
    for (;;) {
        let best = null;
        for (let i = 0; i < groups.length; i++) {
            const center = centroid(groups[i]);
            for (let j = i + 1; j < groups.length; j++) {
                // Centroids further apart than the diameter: so are two of their places
                if (distanceM(center, centroid(groups[j])) > diameter) continue;
                const d = mergedDiameter(groups[i], groups[j]);
                if (d <= diameter && (!best || d < best.d)) best = { i, j, d };
            }
        }
        if (!best) return groups;
        groups[best.i] = groups[best.i].concat(groups[best.j]);
        groups.splice(best.j, 1);
    }
}

const closest = (point, places) => places.reduce((best, p) =>
    (distanceM(point, p) < distanceM(point, best) ? p : best));

const round5 = x => Math.round(x * 1e5) / 1e5;

const diameter = Number(process.argv[2]) || ZONE_DIAMETER_M;
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const stops = data.places.filter(p => STOP_CATEGORIES.has(p.category));
data.places.forEach(p => { delete p.zone; });

// A zone is named after the metro station or bus stop closest to its centroid; sorted by name, so
// that the indices do not depend on the merge order
const zones = clusterPlaces(data.places.filter(p => ZONE_CATEGORIES.has(p.category)), diameter)
    .map(group => {
        const center = centroid(group);
        return { group, name: closest(center, stops).name, lat: round5(center.lat), lon: round5(center.lon) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.lat - b.lat || a.lon - b.lon);
zones.forEach((zone, index) => zone.group.forEach(p => { p.zone = index; }));

const { sources, categories, places } = data;
const table = zones.map(({ name, lat, lon }) => ({ name, lat, lon }));
fs.writeFileSync(FILE, `${JSON.stringify({ sources, categories, zones: table, places })}\n`);

const sizes = zones.map(z => z.group.length);
const names = new Map();
zones.forEach(z => names.set(z.name, (names.get(z.name) || 0) + 1));
const shared = [...names].filter(([, n]) => n > 1);
console.log(`${zones.length} zones of at most ${diameter} m: ${sizes.filter(n => n >= 3).length} of 3 bars or more, `
    + `${sizes.filter(n => n === 2).length} of 2, ${sizes.filter(n => n === 1).length} of 1; largest ${Math.max(...sizes)} bars`);
console.log(`${shared.length} names shared by several zones${shared.length ? `: ${shared.map(([name, n]) => `${name} (${n})`).join(', ')}` : ''}`);
