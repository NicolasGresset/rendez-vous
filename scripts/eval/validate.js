// validate.js - How far the oracle's times (oracle.js, local MOTIS on the Tisséo GTFS) are from
// the services the tool uses: 30 transit trips also asked to the Tisséo API (tisseo.js, run in
// headless Firefox for its DOMParser; 2 calls per trip), and 3 openrouteservice matrices (one per
// street mode, 10 x 10); and how far the oracle's cheap transit estimate is from its exact times.
// Needs: the dev server (node scripts/dev-server.js), local MOTIS, TISSEO_API_KEY and
// OPENROUTESERVICE_API_KEY in .env. Usage: node scripts/eval/validate.js [--json file]

import fs from 'fs';
import { createRequire } from 'module';
import { durationMatrix } from '../../js/ors.js';
import { CASES, DATE, SLOT, TOLERANCE_MIN } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';

const { withFirefox } = createRequire(import.meta.url)('../firefox-bidi.js');
const DEV_URL = 'http://localhost:3001/';
const TRIPS_PER_CASE = 3;
const SLOT_TO = SLOT.replace(/\d+$/, m => String(Number(m) + TOLERANCE_MIN).padStart(2, '0'));

const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const tisseoKey = env.TISSEO_API_KEY;
const orsKey = env.OPENROUTESERVICE_API_KEY || env.OPENROUTESERVICE_API_JEY;

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);

// Deterministic pseudo-random choice (no Math.random: the same trips at every run)
let seed = 12345;
const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

// 3 trips per case: a participant and a place 10 to 70 min away by transit (oracle)
const trips = [];
for (const testCase of CASES) {
    const oracle = loadOracle(testCase.id);
    for (let k = 0; k < TRIPS_PER_CASE; k++) {
        const i = random(testCase.points.length);
        const eligible = oracle.venues.map((_, j) => j)
            .filter(j => oracle.times[i].transit[j] >= 600 && oracle.times[i].transit[j] <= 4200);
        const j = eligible[random(eligible.length)];
        trips.push({ case: testCase.id, from: testCase.points[i], to: places[j], oracle: oracle.times[i].transit[j] });
    }
}

// Tisséo API, from the page's own module
await withFirefox(async ({ send, context, evaluate }) => {
    await send('browsingContext.navigate', { context, url: DEV_URL, wait: 'complete' });
    const answers = await evaluate(`(async () => {
        const { tisseoTrip } = await import('/js/tisseo.js');
        const trips = ${JSON.stringify(trips.map(t => ({ from: { lat: t.from.lat, lon: t.from.lon }, to: { lat: t.to.lat, lon: t.to.lon } })))};
        const out = [];
        for (const t of trips) {
            try {
                const found = await tisseoTrip(${JSON.stringify(tisseoKey)}, () => {}, t.from, t.to, '${DATE} ${SLOT}', '${DATE} ${SLOT_TO}');
                out.push(found ? found.seconds : null);
            } catch (err) { out.push('error: ' + err.message); }
        }
        return JSON.stringify(out);
    })()`);
    JSON.parse(answers).forEach((a, k) => { trips[k].tisseo = a; });
});

// openrouteservice vs MOTIS street times: the first participant of each case to 10 places
const sources = CASES.map(c => c.points[0]);
const targets = Array.from({ length: 10 }, () => random(places.length));
const street = {};
for (const mode of ['walk', 'bike', 'car']) {
    const { durations } = await durationMatrix(orsKey, mode, sources, targets.map(j => places[j]));
    street[mode] = CASES.flatMap((c, s) => {
        const oracle = loadOracle(c.id);
        return targets.map((j, t) => [durations[s][t], oracle.times[0][mode][j]]);
    }).filter(([a, b]) => a != null && b != null);
}

const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex > 0) fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ trips, street }, null, 1));

const min = s => (typeof s === 'number' ? (s / 60).toFixed(0) : s ?? '-');
console.log('| cas | départ | lieu | oracle | Tisséo API |');
console.log('|---|---|---|---|---|');
for (const t of trips) console.log(`| ${t.case} | ${t.from.name} | ${t.to.name} (${t.to.city}) | ${min(t.oracle)} | ${min(t.tisseo)} |`);
const summary = (label, pairs) => {
    const d = pairs.map(([a, b]) => (a - b) / 60).sort((x, y) => x - y);
    const q = f => d[Math.floor(f * (d.length - 1))].toFixed(1);
    const absMean = (d.reduce((s, x) => s + Math.abs(x), 0) / d.length).toFixed(1);
    console.log(`${label}: ${d.length} pairs, mean |diff| ${absMean} min, min ${q(0)}, median ${q(0.5)}, max ${q(1)}`);
};
const numeric = (a, b) => typeof a === 'number' && typeof b === 'number';
summary('Tisséo API - oracle', trips.filter(t => numeric(t.tisseo, t.oracle)).map(t => [t.tisseo, t.oracle]));
const estimates = CASES.flatMap(c => {
    const { times } = loadOracle(c.id);
    return times.flatMap(t => t.transit.map((x, j) => [t.transitEstimate[j], x])).filter(([a, b]) => a != null && b != null);
});
summary('oracle: cheap estimate (one-to-many) - exact (/plan), every pair', estimates);
for (const mode of Object.keys(street)) {
    summary(`openrouteservice - MOTIS, ${mode}`, street[mode]);
    const ratio = street[mode].map(([a, b]) => a / b).sort((x, y) => x - y);
    console.log(`  ratio openrouteservice / MOTIS: median ${ratio[Math.floor(ratio.length / 2)].toFixed(2)}`);
}
