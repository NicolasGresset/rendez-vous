// build-zones.js - Last step of scripts/regenerate-places.sh: groups the bars of
// data/pois-toulouse.json into zones of bars within a short walk of each other, and rewrites the
// file with each bar's `zone` (an index in the new top-level table `zones`). Rules: docs/pipeline.md § 6.
// Needs a local MOTIS server for the walking times (default http://localhost:8080, MOTIS_URL to
// change; docs/evaluation.md). Can be run alone on the current file (it replaces any previous zones).
// Usage: node scripts/build-zones.js

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const MOTIS_URL = process.env.MOTIS_URL || 'http://localhost:8080';
const ZONE_WALK_S = 5 * 60; // no two bars of a zone further apart than this on foot, either way
// Only pairs this close are asked to MOTIS: walking at 1.2 m/s, ZONE_WALK_S covers 360 m at most
const WALK_REACH_M = 400;
const MATCHING_DISTANCE_M = 250; // as scripts/eval/motis.js
const PARALLEL = 4;
const ZONE_CATEGORIES = new Set(['amenity=bar', 'amenity=pub', 'amenity=biergarten', 'amenity=cafe']); // the engine's "bar"
const STOP_CATEGORIES = new Set(['metro', 'bus']);

// Great-circle distance in meters
function distanceM(a, b) {
    const rad = deg => deg * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const closest = (point, places) => places.reduce((best, p) =>
    (distanceM(point, p) < distanceM(point, best) ? p : best));

// Walking seconds from each place to the places within WALK_REACH_M: a Map per place index
async function walkingTimes(places) {
    const times = places.map(() => new Map());
    let next = 0;
    const worker = async () => {
        while (next < places.length) {
            const i = next++;
            const near = places.map((_, j) => j)
                .filter(j => j !== i && distanceM(places[i], places[j]) <= WALK_REACH_M);
            if (!near.length) continue;
            const res = await fetch(`${MOTIS_URL}/api/v1/one-to-many`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ one: `${places[i].lat};${places[i].lon}`,
                    many: near.map(j => `${places[j].lat};${places[j].lon}`), mode: 'WALK',
                    max: 2 * ZONE_WALK_S, maxMatchingDistance: MATCHING_DISTANCE_M, arriveBy: false }),
            });
            if (!res.ok) throw new Error(`MOTIS ${res.status}: ${await res.text()}`);
            (await res.json()).forEach((d, k) => { if (d.duration != null) times[i].set(near[k], d.duration); });
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return times;
}

// Complete linkage: starting from one group per place, merges the two groups whose longest walk
// once merged is the shortest, as long as it stays within limit. Unlike chaining places close to
// each other, it cannot run away along a street of bars. Lone places stay groups of one.
// Reproducible: ties go to the first groups, in the file's order. Returns groups of indices
function clusterPlaces(count, times, limit) {
    const walk = (a, b) => Math.max(times[a].get(b) ?? Infinity, times[b].get(a) ?? Infinity);
    const groups = Array.from({ length: count }, (_, i) => [i]);
    const longest = (a, b) => {
        let worst = 0;
        for (const x of a) {
            for (const y of b) {
                worst = Math.max(worst, walk(x, y));
                if (worst > limit) return worst;
            }
        }
        return worst;
    };
    for (;;) {
        let best = null;
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const d = longest(groups[i], groups[j]);
                if (d <= limit && (!best || d < best.d)) best = { i, j, d };
            }
        }
        if (!best) return groups;
        groups[best.i] = groups[best.i].concat(groups[best.j]);
        groups.splice(best.j, 1);
    }
}

// The bar closest to the group's centroid: a real place, reachable, unlike the centroid itself
function representative(group) {
    const center = {
        lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
        lon: group.reduce((s, p) => s + p.lon, 0) / group.length,
    };
    return closest(center, group);
}

// The group's streets, most represented first (ties in alphabetical order), without house numbers
function streetsOf(group) {
    const counts = new Map();
    group.forEach(p => {
        const street = (p.street || '').replace(/^\d+\s*(bis|ter|[a-z])?\s+/i, '').trim();
        if (street) counts.set(street, (counts.get(street) || 0) + 1);
    });
    return [...counts].sort(([a, m], [b, n]) => n - m || a.localeCompare(b, 'fr')).map(([street]) => street);
}

// A lone bar's zone has the bar's name. The others have the name of the metro station or bus stop
// closest to their representative; several zones on one stop: the closest to it keeps the name,
// the others take their most represented street not taken yet, or else the stop and a number
function nameZones(zones, stops) {
    const groups = zones.filter(z => z.group.length > 1);
    groups.forEach(z => {
        z.stop = closest(z.rep, stops);
        z.stopM = distanceM(z.rep, z.stop);
    });
    zones.filter(z => z.group.length === 1).forEach(z => { z.name = z.group[0].name; });
    const byStop = new Map();
    groups.forEach(z => byStop.set(z.stop.name, [...(byStop.get(z.stop.name) || []), z]));
    const used = new Set(byStop.keys());
    const stopNames = [...byStop.keys()].sort((a, b) => a.localeCompare(b, 'fr'));
    stopNames.forEach(stopName => {
        const sorted = byStop.get(stopName).sort((a, b) => a.stopM - b.stopM);
        sorted[0].name = stopName;
        sorted.slice(1).forEach((z, k) => {
            z.name = streetsOf(z.group).find(street => !used.has(street)) || `${stopName} ${k + 2}`;
            used.add(z.name);
        });
    });
}

const round5 = x => Math.round(x * 1e5) / 1e5;

(async () => {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data.places.forEach(p => { delete p.zone; });
    const bars = data.places.filter(p => ZONE_CATEGORIES.has(p.category));
    const times = await walkingTimes(bars);
    const zones = clusterPlaces(bars.length, times, ZONE_WALK_S).map(indices => {
        const group = indices.map(i => bars[i]);
        return { group, rep: representative(group) };
    });
    nameZones(zones, data.places.filter(p => STOP_CATEGORIES.has(p.category)));
    // Sorted, so that the indices do not depend on the merge order
    zones.sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.rep.lat - b.rep.lat || a.rep.lon - b.rep.lon);
    zones.forEach((zone, index) => zone.group.forEach(p => { p.zone = index; }));

    const { sources, categories, places } = data;
    const table = zones.map(({ name, rep }) => ({ name, lat: round5(rep.lat), lon: round5(rep.lon) }));
    fs.writeFileSync(FILE, `${JSON.stringify({ sources, categories, zones: table, places })}\n`);

    const sizes = zones.map(z => z.group.length);
    const shared = zones.filter(z => z.group.length > 1).map(z => z.name).filter((name, i, all) => all.indexOf(name) !== i);
    console.log(`${zones.length} zones within ${ZONE_WALK_S / 60} min on foot: ${sizes.filter(n => n >= 3).length} of 3 bars or more, `
        + `${sizes.filter(n => n === 2).length} of 2, ${sizes.filter(n => n === 1).length} of 1; largest ${Math.max(...sizes)} bars; `
        + `${shared.length} names shared by zones of 2 or more${shared.length ? ` (${shared.join(', ')})` : ''}`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
