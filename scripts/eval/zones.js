// zones.js - The method planned with the zones of bars (not in the engine yet), replayed on the stored
// oracle (oracle.js; no MOTIS needed), against the tool's rule and the whole file: score each
// zone's representative within a radius of the barycenter, keep the best 3 zones, then score every
// bar of these 3 and show the best bar of each. Bars only. Places scored count one transit
// journey per participant using transit. Usage: node scripts/eval/zones.js

import fs from 'fs';
import { CATEGORIES } from '../../js/engine.js';
import { CASES, CONFIGS } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { METRICS, oracleScores } from './scoring.js';

const CAR_PARKING_S = 5 * 60; // as engine.js
const SPACING_M = 700;        // as engine.js
const CANDIDATES = 8;         // as engine.js
const MIN_ZONES = 8;          // the radius grows until this many zones are found
const RADIUS_STEP_M = 500;
const RADIUS_MAX_M = 30000;
const PROPOSALS = 3;

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const barycenter = points => {
    const people = points.reduce((s, p) => s + p.people, 0);
    return { lat: points.reduce((s, p) => s + p.people * p.lat, 0) / people, lon: points.reduce((s, p) => s + p.people * p.lon, 0) / people };
};
// Greedy: first-ranked items at least spacing apart, up to count
const spacedOut = (items, spacing, count) => {
    const kept = [];
    for (const item of items) {
        if (kept.length < count && kept.every(k => dist(k, item) >= spacing)) kept.push(item);
    }
    return kept;
};

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const bars = candidatePlaces(data).filter(p => CATEGORIES.bar.includes(p.category));
const members = data.zones.map(() => []);
bars.forEach(p => members[p.zone].push(p));
const zones = data.zones.map((zone, index) => ({ ...zone, bars: members[index] }));

const rows = {};
const add = (name, row) => (rows[name] ??= []).push(row);

for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    const center = barycenter(testCase.points);
    const byDistance = [...bars].sort((a, b) => dist(center, a) - dist(center, b));
    for (const config of Object.values(CONFIGS)) {
        const participants = testCase.points.map((p, i) => ({ ...p, modes: config.modes(i) }));
        const transitUsers = participants.filter(p => p.modes.includes('transit')).length;
        for (const metric of Object.keys(METRICS)) {
            const scores = oracleScores(oracle, participants, metric, CAR_PARKING_S);
            const score = p => scores[index.get(p.id)];
            const best = Math.min(...bars.map(score).filter(s => s != null));
            const ranked = list => list.filter(p => score(p) != null).sort((a, b) => score(a) - score(b));
            const record = (name, shown, scored, radius) => add(`${metric}|${name}`, {
                first: shown.length ? (score(shown[0]) - best) / 60 : null,
                last: shown.length ? (score(shown[shown.length - 1]) - best) / 60 : null,
                count: shown.length,
                closest: Math.min(...shown.flatMap((a, i) => shown.slice(i + 1).map(b => dist(a, b)))),
                scored, journeys: scored * transitUsers, radius,
            });

            // The tool: closest places SPACING_M apart, best 3
            const toolPool = spacedOut(byDistance, SPACING_M, CANDIDATES);
            record('outil : 8 bars espacés', ranked(toolPool).slice(0, PROPOSALS), toolPool.length, 0);
            // The whole file, best 3 at least SPACING_M apart: what scoring everything would give
            record('tous les bars, espacés', spacedOut(ranked(bars), SPACING_M, PROPOSALS), bars.length, 0);

            for (const [name, start] of [['toutes les zones', RADIUS_MAX_M], ['zones à 2 km', 2000], ['zones à 3 km', 3000], ['zones à 4 km', 4000]]) {
                let radius = start;
                let pool = zones.filter(z => dist(center, z) <= radius);
                while (pool.length < MIN_ZONES && radius < RADIUS_MAX_M) {
                    radius += RADIUS_STEP_M;
                    pool = zones.filter(z => dist(center, z) <= radius);
                }
                // A zone's representative is its bar at the zone's position
                const representative = z => z.bars.reduce((b, p) => (dist(z, p) < dist(z, b) ? p : b));
                const scoredZones = pool.map(z => ({ ...z, rep: representative(z), lat: z.lat, lon: z.lon }))
                    .filter(z => score(z.rep) != null).sort((a, b) => score(a.rep) - score(b.rep));
                const kept = spacedOut(scoredZones, SPACING_M, PROPOSALS);
                record(`${name}, représentant`, kept.map(z => z.rep), pool.length, radius);
                const refined = kept.map(z => ranked(z.bars)[0]).sort((a, b) => score(a) - score(b));
                record(`${name}, puis recalcul`, refined, pool.length + kept.reduce((s, z) => s + z.bars.length - 1, 0), radius);
            }
        }
    }
}

const quantile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const metric of Object.keys(METRICS)) {
    console.log(`\n## ${METRICS[metric].label}, bars et cafés, ${rows[`${metric}|outil : 8 bars espacés`].length} lignes (min, écart au meilleur bar du fichier)\n`);
    console.log('| méthode | n° 1 méd. / moy. / max | > 5 min | dernier moy. | 2 plus proches, méd. | < 3 propositions | lieux notés moy. | trajets TC moy. / max |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const [key, list] of Object.entries(rows).filter(([k]) => k.startsWith(`${metric}|`))) {
        const first = list.map(r => r.first).filter(x => x != null);
        console.log(`| ${key.split('|')[1]} | ${quantile(first, .5).toFixed(1)} / ${mean(first).toFixed(1)} / ${Math.max(...first).toFixed(1)} `
            + `| ${first.filter(x => x > 5).length} | ${mean(list.map(r => r.last).filter(x => x != null)).toFixed(1)} `
            + `| ${Math.round(quantile(list.map(r => r.closest).filter(Number.isFinite), .5))} m | ${list.filter(r => r.count < PROPOSALS).length} `
            + `| ${mean(list.map(r => r.scored)).toFixed(0)} | ${mean(list.map(r => r.journeys)).toFixed(0)} / ${Math.max(...list.map(r => r.journeys))} |`);
    }
}
