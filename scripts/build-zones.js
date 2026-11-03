// build-zones.js - Last step of scripts/regenerate-places.sh: groups the bars, cafés and
// restaurants, each kind apart, of data/pois-toulouse.json into zones of places within a short walk of each other,
// and rewrites the file with each place's `zone` (an index in the new top-level table `zones`).
// Rules: docs/pipeline.md § 6.
// Needs a local MOTIS server for the walking times (default http://localhost:8080, MOTIS_URL to
// change; docs/evaluation.md). Can be run alone on the current file (it replaces any previous zones).
// Usage: node scripts/build-zones.js

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const MOTIS_URL = process.env.MOTIS_URL || 'http://localhost:8080';
const ZONE_WALK_S = 5 * 60; // no two places of a zone further apart than this on foot, either way
// Only pairs this close are asked to MOTIS: walking at 1.2 m/s, ZONE_WALK_S covers 360 m at most
const WALK_REACH_M = 400;
const MATCHING_DISTANCE_M = 250; // as scripts/eval/motis.js
const PARALLEL = 4;
// Kinds of zones, as the keys and categories of the engine's CATEGORIES
const ZONE_KINDS = {
    bar: new Set(['amenity=bar', 'amenity=pub', 'amenity=biergarten']),
    cafe: new Set(['amenity=cafe']),
    restaurant: new Set(['amenity=restaurant']),
};
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
    const groups = new Map(Array.from({ length: count }, (_, i) => [i, [i]])); // by the id of their first place
    const groupOf = Array.from({ length: count }, (_, i) => i);
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
        for (const [i, group] of groups) {
            // Only groups holding a neighbour of its first place can merge with it
            const others = [...new Set([...times[group[0]].keys()].map(k => groupOf[k]))]
                .filter(j => j > i).sort((a, b) => a - b);
            for (const j of others) {
                const d = longest(group, groups.get(j));
                if (d <= limit && (!best || d < best.d)) best = { i, j, d };
            }
        }
        if (!best) return [...groups.values()];
        const merged = groups.get(best.j);
        merged.forEach(k => { groupOf[k] = best.i; });
        groups.set(best.i, groups.get(best.i).concat(merged));
        groups.delete(best.j);
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
    const stops = data.places.filter(p => STOP_CATEGORIES.has(p.category));
    const zones = [];
    for (const [kind, categories] of Object.entries(ZONE_KINDS)) {
        const members = data.places.filter(p => categories.has(p.category));
        const times = await walkingTimes(members);
        const ofKind = clusterPlaces(members.length, times, ZONE_WALK_S).map(indices => {
            const group = indices.map(i => members[i]);
            return { kind, group, rep: representative(group) };
        });
        nameZones(ofKind, stops);
        // Sorted, so that the indices do not depend on the merge order
        ofKind.sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.rep.lat - b.rep.lat || a.rep.lon - b.rep.lon);
        zones.push(...ofKind);

        const sizes = ofKind.map(z => z.group.length);
        const shared = ofKind.filter(z => z.group.length > 1).map(z => z.name).filter((name, i, all) => all.indexOf(name) !== i);
        console.log(`${kind}: ${ofKind.length} zones within ${ZONE_WALK_S / 60} min on foot: ${sizes.filter(n => n >= 3).length} of 3 places or more, `
            + `${sizes.filter(n => n === 2).length} of 2, ${sizes.filter(n => n === 1).length} of 1; largest ${Math.max(...sizes)}; `
            + `${shared.length} names shared by zones of 2 or more${shared.length ? ` (${shared.join(', ')})` : ''}`);
    }
    zones.forEach((zone, index) => zone.group.forEach(p => { p.zone = index; }));

    const { sources, categories, addressSources, places } = data;
    const table = zones.map(({ kind, name, rep }) => ({ kind, name, lat: round5(rep.lat), lon: round5(rep.lon) }));
    fs.writeFileSync(FILE, `${JSON.stringify({ sources, categories, addressSources, zones: table, places })}\n`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
