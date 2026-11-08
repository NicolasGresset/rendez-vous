// zone-cap.js - A maximum of places scored exactly per zone, kept in the third phase of the method by
// zones (js/debug-motis.js scoreZones), against every place of the 3 zones kept. The places are picked
// around the representative, already exact: the closest ones, or farthest first (each time the place
// farthest from those picked, the distance to a set being the one to its closest member, as the crow
// flies). Replayed on the oracle (oracle.js; estimates from the local MOTIS, forward, 60 min before the
// meeting time); then the third phase's real time on the local MOTIS, 8 calls in parallel, as the page.
// Usage: node scripts/eval/zone-cap.js

import fs from 'fs';
import { forEachLimited, transitTrip } from './common.js';
import { CASES, CONFIGS, DATE, SLOT, TOLERANCE_MIN } from './cases.js';
import { MOTIS_URL } from './motis.js';
import { loadOracle } from './oracle.js';
import { METRICS, oracleScores } from './scoring.js';

const CAR_PARKING_S = 5 * 60; // as engine.js
const SPACING_M = 500;        // as debug-motis.js
const SHORTLIST = 20;         // as debug-motis.js
const PROPOSALS = 3;
const PARALLEL = 8;
const DEPARTURE = new Date(`${DATE}T17:00:00Z`); // 18:00 in Toulouse, 60 min before the meeting time
const SLOT_TO = SLOT.replace(/\d+$/, m => String(Number(m) + TOLERANCE_MIN).padStart(2, '0'));
const SETS = { 'bars': ['bar'], 'cafés': ['cafe'], 'restaurants': ['restaurant'], 'bars, cafés, restaurants': ['bar', 'cafe', 'restaurant'] };

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// The representative then, up to cap places in all, the members closest to it
function closest(zone, cap) {
    return [zone.rep, ...zone.members.filter(p => p !== zone.rep).sort((a, b) => dist(zone.rep, a) - dist(zone.rep, b))].slice(0, cap);
}

// The representative then, up to cap places in all, each time the member farthest from those picked
function farthestFirst(zone, cap) {
    const picked = [zone.rep];
    const left = new Map(zone.members.filter(p => p !== zone.rep).map(p => [p, dist(zone.rep, p)]));
    while (picked.length < cap && left.size) {
        const [next] = [...left].reduce((a, b) => (b[1] > a[1] ? b : a));
        picked.push(next);
        left.delete(next);
        left.forEach((d, p) => left.set(p, Math.min(d, dist(next, p))));
    }
    return picked;
}

const METHODS = {
    'tous les lieux (actuel)': zone => zone.members,
    'les 5 plus proches': zone => closest(zone, 5),
    'les plus éloignés, 3': zone => farthestFirst(zone, 3),
    'les plus éloignés, 5': zone => farthestFirst(zone, 5),
    'les plus éloignés, 8': zone => farthestFirst(zone, 8),
};

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
const allReps = allZones.map(z => z.rep);

const rows = {};
const add = (metric, setName, name, row) => (rows[`${metric}|${setName}|${name}`] ??= []).push(row);
const timed = []; // third phases to time: { participants (transit only), methods: { name: places } }

for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    const found = await Promise.all(testCase.points.map(p => forward(p, allReps)));
    const times = oracle.times.map((t, i) => {
        const transit = [...t.transit];
        allReps.forEach((p, k) => { transit[index.get(p.id)] = found[i][k]; });
        return { ...t, transit };
    });
    for (const [configName, config] of Object.entries(CONFIGS)) {
        const participants = testCase.points.map((p, i) => ({ ...p, modes: config.modes(i) }));
        const transitUsers = participants.filter(p => p.modes.includes('transit'));
        for (const metric of Object.keys(METRICS)) {
            const exact = oracleScores(oracle, participants, metric, CAR_PARKING_S);
            const estimated = oracleScores({ ...oracle, times }, participants, metric, CAR_PARKING_S);
            const score = p => exact[index.get(p.id)];
            const estimate = p => estimated[index.get(p.id)];
            const ranked = list => list.filter(p => score(p) != null).sort((a, b) => score(a) - score(b));
            for (const [setName, kinds] of Object.entries(SETS)) {
                const zones = allZones.filter(z => kinds.includes(z.kind));
                const best = score(ranked(zones.flatMap(z => z.members))[0]);
                const order = zones.filter(z => estimate(z.rep) != null).sort((a, b) => estimate(a.rep) - estimate(b.rep));
                let kept = [];
                for (let size = SHORTLIST; ; size += SHORTLIST) {
                    const short = order.slice(0, size).filter(z => score(z.rep) != null).sort((a, b) => score(a.rep) - score(b.rep));
                    kept = [];
                    for (const z of short) if (kept.length < PROPOSALS && kept.every(k => dist(k.rep, z.rep) >= SPACING_M)) kept.push(z);
                    if (kept.length === PROPOSALS || size >= order.length) break;
                }
                const trueBest = kept.map(z => ranked(z.members)[0]);
                const trueFirst = Math.min(...trueBest.map(score));
                const places = {};
                for (const [name, pick] of Object.entries(METHODS)) {
                    const picks = kept.map(pick);
                    places[name] = picks.flatMap((list, k) => list.filter(p => p !== kept[k].rep));
                    const shown = picks.map(list => ranked(list)[0]);
                    const first = Math.min(...shown.map(score));
                    const spreads = picks.filter(list => list.length > 1).map(list => mean(list.slice(1).map(p => dist(list[0], p))));
                    add(metric, setName, name, {
                        firstVsFile: (first - best) / 60,
                        firstVsAll: (first - trueFirst) / 60,
                        // Per zone kept: the zone's best place found? how much is lost when it is not?
                        zoneLoss: shown.map((p, k) => (score(p) - score(trueBest[k])) / 60),
                        rankChanged: shown.map(score).map((s, k) => [s, k]).sort((a, b) => a[0] - b[0]).map(x => x[1]).join()
                            !== trueBest.map(score).map((s, k) => [s, k]).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(),
                        scored: places[name].length,
                        journeys: places[name].length * transitUsers.length,
                        spread: spreads.length ? mean(spreads) : null,
                    });
                }
                if (metric === 'half' && configName === 'transit') timed.push({ testCase: testCase.id, setName, participants: transitUsers, places });
            }
        }
    }
}

for (const metric of Object.keys(METRICS)) {
    console.log(`\n## ${METRICS[metric].label}, 30 lignes (min)\n`);
    console.log('| lieux | méthode | n° 1 / meilleur du fichier moy. / max | n° 1 / tous les lieux, moy. / max | zones au meilleur lieu | perte par zone moy. / max | ordre changé | trajets phase 3 moy. / max | distance au représentant (m) |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const [key, list] of Object.entries(rows).filter(([k]) => k.startsWith(`${metric}|`))) {
        const [, setName, name] = key.split('|');
        const f = list.map(r => r.firstVsFile);
        const a = list.map(r => r.firstVsAll);
        const z = list.flatMap(r => r.zoneLoss);
        const spreads = list.map(r => r.spread).filter(s => s != null);
        console.log(`| ${setName} | ${name} | ${mean(f).toFixed(2)} / ${Math.max(...f).toFixed(1)} | ${mean(a).toFixed(2)} / ${Math.max(...a).toFixed(1)} `
            + `| ${(100 * z.filter(x => x === 0).length / z.length).toFixed(0)} % | ${mean(z).toFixed(2)} / ${Math.max(...z).toFixed(1)} `
            + `| ${list.filter(r => r.rankChanged).length} / ${list.length} `
            + `| ${mean(list.map(r => r.journeys)).toFixed(1)} / ${Math.max(...list.map(r => r.journeys))} | ${spreads.length ? mean(spreads).toFixed(0) : '-'} |`);
    }
}

// The third phase's journeys on the local MOTIS, walk + transit, équitable: all, then the maximum
console.log('\n## Durée réelle des trajets de la phase 3 (marche + transports, équitable, 10 groupes, 8 en parallèle)\n');
console.log('| lieux | méthode | trajets moy. / max | durée moy. / max |');
console.log('|---|---|---|---|');
for (const setName of Object.keys(SETS)) {
    for (const name of ['tous les lieux (actuel)', 'les plus éloignés, 5']) {
        const runs = [];
        for (const run of timed.filter(t => t.setName === setName)) {
            const pairs = run.participants.flatMap(p => run.places[name].map(place => [p, place]));
            const started = performance.now();
            await forEachLimited(pairs, PARALLEL, ([p, place]) => transitTrip(p, place, `${DATE} ${SLOT}`, `${DATE} ${SLOT_TO}`, `${MOTIS_URL}/api/v6/plan`));
            runs.push({ journeys: pairs.length, seconds: (performance.now() - started) / 1000 });
        }
        console.log(`| ${setName} | ${name} | ${mean(runs.map(r => r.journeys)).toFixed(0)} / ${Math.max(...runs.map(r => r.journeys))} `
            + `| ${mean(runs.map(r => r.seconds)).toFixed(2)} s / ${Math.max(...runs.map(r => r.seconds)).toFixed(2)} s |`);
    }
}
