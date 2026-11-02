// zones-gain.js - What do the zones bring? One estimate's time by number of destinations, then the same
// method with and without zones, replayed on the oracle (oracle.js; estimates from the local MOTIS,
// forward, 60 min before the meeting time). With zones: every representative estimated, the 20 best
// exact, 3 zones 500 m apart, their other places exact. Without: every place estimated, the K best
// exact, the best 3 places 500 m apart. Usage: node scripts/eval/zones-gain.js

import fs from 'fs';
import { CATEGORIES } from '../../js/engine.js';
import { CASES, CONFIGS, DATE } from './cases.js';
import { MOTIS_URL } from './motis.js';
import { loadOracle } from './oracle.js';
import { METRICS, oracleScores } from './scoring.js';

const CAR_PARKING_S = 5 * 60; // as engine.js
const SPACING_M = 500;
const PROPOSALS = 3;
const DEPARTURE = new Date(`${DATE}T17:00:00Z`); // 18:00 in Toulouse, 60 min before the meeting time
const SIZES = [10, 100, 161, 316, 800, 851, 2029];
const REPEATS = 7;
const WITHOUT_ZONES = [20, 30, 40, 60, 100];

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const quantile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

async function forward(point, many) {
    const res = await fetch(`${MOTIS_URL}/api/experimental/one-to-many-intermodal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ one: `${point.lat},${point.lon}`, many: many.map(p => `${p.lat},${p.lon}`), time: DEPARTURE.toISOString(), arriveBy: false }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body.transit_durations.map(set => (set.length ? Math.min(...set.map(e => e.duration)) : null));
}

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const members = data.zones.map(() => []);
data.places.forEach(p => { if (p.zone != null) members[p.zone].push(p); });
const allZones = data.zones.map((zone, i) => ({ ...zone, members: members[i] }));
allZones.forEach(z => { z.rep = z.members.reduce((b, p) => (dist(z, p) < dist(z, b) ? p : b)); });
const allPlaces = allZones.flatMap(z => z.members);

// ---- Time of one search by number of destinations, sequential ----
console.log('## Une recherche, 1 participant vers N destinations (médiane de 7, séquentiel)\n');
const origin = CASES.find(c => c.id === 'T4').points[1];
for (const size of SIZES) {
    const many = allPlaces.filter((_, k) => k % Math.max(1, Math.floor(allPlaces.length / size)) === 0).slice(0, size);
    const times = [];
    for (let r = 0; r < REPEATS; r++) {
        const t = performance.now();
        await forward(origin, many);
        times.push(performance.now() - t);
    }
    console.log(`- ${many.length} destinations : ${Math.round(quantile(times, .5))} ms`);
}

// ---- With and without zones ----
const SETS = { 'bars': ['bar'], 'bars, cafés, restaurants': ['bar', 'cafe', 'restaurant'] };
const rows = {};
for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    // Estimates to every place of a zone, for each participant
    const found = await Promise.all(testCase.points.map(p => forward(p, allPlaces)));
    const times = oracle.times.map((t, i) => {
        const transit = [...t.transit];
        allPlaces.forEach((p, k) => { transit[index.get(p.id)] = found[i][k]; });
        return { ...t, transit };
    });
    for (const config of Object.values(CONFIGS)) {
        const participants = testCase.points.map((p, i) => ({ ...p, modes: config.modes(i) }));
        const transitUsers = participants.filter(p => p.modes.includes('transit')).length;
        for (const metric of Object.keys(METRICS)) {
            const exact = oracleScores(oracle, participants, metric, CAR_PARKING_S);
            const estimated = oracleScores({ ...oracle, times }, participants, metric, CAR_PARKING_S);
            const score = p => exact[index.get(p.id)];
            const estimate = p => estimated[index.get(p.id)];
            const ranked = list => list.filter(p => score(p) != null).sort((a, b) => score(a) - score(b));
            for (const [setName, kinds] of Object.entries(SETS)) {
                const zones = allZones.filter(z => kinds.includes(z.kind));
                const places = zones.flatMap(z => z.members);
                const best = score(ranked(places)[0]);
                const spaced = (items, pos = x => x) => {
                    const kept = [];
                    for (const item of items) if (kept.length < PROPOSALS && kept.every(k => dist(pos(k), pos(item)) >= SPACING_M)) kept.push(item);
                    return kept;
                };
                const record = (name, shown, estimates, scored) => (rows[`${metric}|${setName}|${name}`] ??= []).push({
                    first: (score(shown[0]) - best) / 60, last: (score(shown[shown.length - 1]) - best) / 60,
                    count: shown.length, estimates, scored, journeys: scored * transitUsers,
                });
                // With zones
                let order = zones.filter(z => estimate(z.rep) != null).sort((a, b) => estimate(a.rep) - estimate(b.rep));
                let size = 20;
                let kept = [];
                for (; ; size += 20) {
                    const short = order.slice(0, size).filter(z => score(z.rep) != null).sort((a, b) => score(a.rep) - score(b.rep));
                    kept = spaced(short, z => z.rep);
                    if (kept.length === PROPOSALS || size >= order.length) break;
                }
                record('zones', kept.map(z => ranked(z.members)[0]).sort((a, b) => score(a) - score(b)), zones.length,
                    Math.min(size, order.length) + kept.reduce((s, z) => s + z.members.length - 1, 0));
                // Without zones: the places themselves
                const placesOrder = places.filter(p => estimate(p) != null).sort((a, b) => estimate(a) - estimate(b));
                for (const k of WITHOUT_ZONES) {
                    let n = k;
                    let shown = [];
                    for (; ; n += 20) {
                        shown = spaced(ranked(placesOrder.slice(0, n)));
                        if (shown.length === PROPOSALS || n >= placesOrder.length) break;
                    }
                    record(`sans zones, ${k} meilleurs`, shown, places.length, Math.min(n, placesOrder.length));
                }
            }
        }
    }
}
for (const metric of Object.keys(METRICS)) {
    console.log(`\n## ${METRICS[metric].label}, 30 lignes, écart au meilleur lieu du fichier (min)\n`);
    console.log('| lieux | méthode | n° 1 moy. / max | 3e moy. | destinations estimées | lieux exacts moy. / max | trajets exacts moy. / max |');
    console.log('|---|---|---|---|---|---|---|');
    for (const [key, list] of Object.entries(rows).filter(([k]) => k.startsWith(`${metric}|`))) {
        const [, setName, name] = key.split('|');
        const first = list.map(r => r.first);
        console.log(`| ${setName} | ${name} | ${mean(first).toFixed(1)} / ${Math.max(...first).toFixed(1)} | ${mean(list.map(r => r.last)).toFixed(1)} | ${list[0].estimates} `
            + `| ${mean(list.map(r => r.scored)).toFixed(0)} / ${Math.max(...list.map(r => r.scored))} | ${mean(list.map(r => r.journeys)).toFixed(0)} / ${Math.max(...list.map(r => r.journeys))} |`);
    }
}
