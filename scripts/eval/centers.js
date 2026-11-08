// centers.js - Which center should the zones be searched around (or no center at all, every zone
// ranked with the cheap estimate), and how far apart should the zones kept be? Replayed on the stored oracle (oracle.js; no MOTIS needed), bars, same method as zones.js:
// each representative within the radius scored, the best 3 zones, every bar of these 3 scored. Also
// each mode's speed as the oracle sees it, for the weights of the geometric median.
// Usage: node scripts/eval/centers.js

import fs from 'fs';
import { CATEGORIES } from './common.js';
import { CASES, CONFIGS } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { METRICS, oracleScores } from './scoring.js';

const CAR_PARKING_S = 5 * 60; // as engine.js
const MIN_ZONES = 8;
const RADIUS_STEP_M = 500;
const RADIUS_MAX_M = 30000;
const PROPOSALS = 3;
const WEISZFELD_STEPS = 100;

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const quantile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

const weightedMean = (points, weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    return { lat: points.reduce((s, p, i) => s + weights[i] * p.lat, 0) / total,
        lon: points.reduce((s, p, i) => s + weights[i] * p.lon, 0) / total };
};
// Weighted geometric median (Weiszfeld): the point with the lowest sum of weight x distance
const geometricMedian = (points, weights) => {
    let center = weightedMean(points, weights);
    for (let step = 0; step < WEISZFELD_STEPS; step++) {
        const inverse = points.map((p, i) => weights[i] / Math.max(dist(center, p), 1));
        center = weightedMean(points, inverse);
    }
    return center;
};

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);
const bars = places.filter(p => CATEGORIES.bar.includes(p.category));
const members = data.zones.map(() => []);
bars.forEach(p => members[p.zone].push(p));
const zones = data.zones.map((zone, index) => ({ ...zone, bars: members[index] })).filter(z => z.kind === 'bar');
const representative = z => z.bars.reduce((b, p) => (dist(z, p) < dist(z, b) ? p : b));

// Speed of each mode: straight-line distance over time, every participant to every place
const speeds = { walk: [], bike: [], car: [], transit: [] };
for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    testCase.points.forEach((point, i) => {
        for (const place of places) {
            const d = dist(point, place);
            if (d < 1000) continue;
            for (const mode of Object.keys(speeds)) {
                let t = oracle.times[i][mode][index.get(place.id)];
                if (t == null) continue;
                if (mode === 'car') t += CAR_PARKING_S;
                speeds[mode].push({ kmh: d / t * 3.6, d });
            }
        }
    });
}
console.log('## Vitesse à vol d\'oiseau, km/h, participant -> lieu à plus de 1 km (médiane ; 10 % - 90 %)\n');
for (const [mode, list] of Object.entries(speeds)) {
    const kmh = list.map(x => x.kmh);
    const line = [[1000, 3000], [3000, 6000], [6000, 12000], [12000, 99000]].map(([a, b]) => {
        const part = list.filter(x => x.d >= a && x.d < b).map(x => x.kmh);
        return `${a / 1000}-${b / 1000} km ${part.length ? quantile(part, .5).toFixed(1) : '-'}`;
    }).join(', ');
    console.log(`- ${mode}: ${quantile(kmh, .5).toFixed(1)} (${quantile(kmh, .1).toFixed(1)} - ${quantile(kmh, .9).toFixed(1)}) ; ${line}`);
}

// Each mode's speed in km/h at a straight line, as measured above. Weight of a participant in a
// median: people / speed of their fastest mode: a fast mode covers the same distance in less time, so
// it pulls the center less
const SPEEDS = { walk: 3.7, bike: 12.6, car: 26, transit: 10 };
const speedOf = p => Math.max(...p.modes.map(m => SPEEDS[m]));
const SCORE_CENTER_CELLS = 40;
// The point of the participants' box with the best score, each time estimated as distance / speed
function scoreCenter(participants, metric) {
    const lats = participants.map(p => p.lat);
    const lons = participants.map(p => p.lon);
    const people = participants.map(p => p.people);
    let best = null;
    for (let r = 0; r <= SCORE_CENTER_CELLS; r++) {
        for (let c = 0; c <= SCORE_CENTER_CELLS; c++) {
            const point = { lat: Math.min(...lats) + (Math.max(...lats) - Math.min(...lats)) * r / SCORE_CENTER_CELLS,
                lon: Math.min(...lons) + (Math.max(...lons) - Math.min(...lons)) * c / SCORE_CENTER_CELLS };
            const value = METRICS[metric].score(participants.map(p => dist(point, p) / speedOf(p)), people);
            if (!best || value < best.value) best = { point, value };
        }
    }
    return best.point;
}
const CENTERS = {
    'barycentre': participants => weightedMean(participants, participants.map(p => p.people)),
    'médiane (personnes)': participants => geometricMedian(participants, participants.map(p => p.people)),
    'médiane (personnes / vitesse)': participants => geometricMedian(participants, participants.map(p => p.people / speedOf(p))),
    'centre du score (distance / vitesse)': (participants, metric) => scoreCenter(participants, metric),
};
const ESTIMATE_SHORTLIST = 20;
const RULES = { '700 m': 700, '500 m': 500, '300 m': 300, 'aucune': 0 };

const spaced = (items, spacing, count) => {
    const kept = [];
    for (const item of items) {
        if (kept.length < count && kept.every(k => dist(k, item) >= spacing)) kept.push(item);
    }
    return kept;
};

const rows = {};
for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    for (const [configName, config] of Object.entries(CONFIGS)) {
        const participants = testCase.points.map((p, i) => ({ ...p, modes: config.modes(i) }));
        const transitUsers = participants.filter(p => p.modes.includes('transit')).length;
        for (const metric of Object.keys(METRICS)) {
            const scores = oracleScores(oracle, participants, metric, CAR_PARKING_S);
            const score = p => scores[index.get(p.id)];
            const ranked = list => list.filter(p => score(p) != null).sort((a, b) => score(a) - score(b));
            const allBars = ranked(bars);
            const best = score(allBars[0]);
            // Every zone ranked with the cheap transit estimate (one call per zone), not by distance
            const estimateOracle = { ...oracle, times: oracle.times.map(t => ({ ...t, transit: t.transitEstimate })) };
            const estimates = oracleScores(estimateOracle, participants, metric, CAR_PARKING_S);
            const estimated = zones.map(z => ({ ...z, rep: representative(z) }))
                .filter(z => estimates[index.get(z.rep.id)] != null)
                .sort((a, b) => estimates[index.get(a.rep.id)] - estimates[index.get(b.rep.id)])
                .slice(0, ESTIMATE_SHORTLIST);
            const methods = { 'estimation de toutes les zones, 20 exactes': { pool: estimated, extraCalls: transitUsers ? zones.length : 0 } };
            for (const [centerName, centerOf] of Object.entries(CENTERS)) {
                const center = centerOf(participants, metric);
                let radius = 3000;
                let pool = zones.filter(z => dist(center, z) <= radius);
                while (pool.length < MIN_ZONES && radius < RADIUS_MAX_M) {
                    radius += RADIUS_STEP_M;
                    pool = zones.filter(z => dist(center, z) <= radius);
                }
                methods[`${centerName}, 3 km`] = { pool: pool.map(z => ({ ...z, rep: representative(z) })), extraCalls: 0 };
            }
            for (const [method, { pool, extraCalls }] of Object.entries(methods)) {
                const scored = pool.filter(z => score(z.rep) != null).sort((a, b) => score(a.rep) - score(b.rep));
                for (const [rule, spacing] of Object.entries(RULES)) {
                    const kept = spaced(scored, spacing, PROPOSALS);
                    const shown = kept.map(z => ranked(z.bars)[0]).sort((a, b) => score(a) - score(b));
                    const distances = shown.flatMap((a, i) => shown.slice(i + 1).map(b => dist(a, b)));
                    (rows[`${metric}|${method}|${rule}`] ??= []).push({
                        row: `${testCase.id} ${configName}`,
                        first: (score(shown[0]) - best) / 60,
                        last: (score(shown[shown.length - 1]) - best) / 60,
                        closest: Math.min(...distances),
                        under300: distances.some(d => d < 300),
                        journeys: (pool.length + kept.reduce((s, z) => s + z.bars.length - 1, 0)) * transitUsers,
                        extraCalls,
                    });
                }
            }
        }
    }
}

for (const metric of Object.keys(METRICS)) {
    console.log(`\n## ${METRICS[metric].label}, bars, 30 lignes, écart au meilleur bar du fichier (min)\n`);
    console.log('| méthode | entre zones | n° 1 méd. / moy. / max | > 5 min | pire ligne | 3e moy. | 2 plus proches méd. | lignes < 300 m | trajets moy. / max | estimations |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const [key, list] of Object.entries(rows).filter(([k]) => k.startsWith(`${metric}|`))) {
        const [, method, rule] = key.split('|');
        const first = list.map(r => r.first);
        const worst = list.reduce((a, b) => (b.first > a.first ? b : a));
        console.log(`| ${method} | ${rule} | ${quantile(first, .5).toFixed(1)} / ${mean(first).toFixed(1)} / ${Math.max(...first).toFixed(1)} `
            + `| ${first.filter(x => x > 5).length} | ${worst.row} | ${mean(list.map(r => r.last)).toFixed(1)} | ${Math.round(quantile(list.map(r => r.closest), .5))} m `
            + `| ${list.filter(r => r.under300).length} | ${mean(list.map(r => r.journeys)).toFixed(0)} / ${Math.max(...list.map(r => r.journeys))} | ${list[0].extraCalls ? zones.length : 0} |`);
    }
}
