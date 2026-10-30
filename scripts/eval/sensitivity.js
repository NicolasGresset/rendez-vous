// sensitivity.js - Do the arrival rules change the proposed places? From the oracle (street
// times) and the stored transit journeys (journeys.js), every candidate place is ranked under
// several definitions of a participant's time, and each is compared with the tool's (reference:
// 10 min late tolerance, no waiting of the first one to arrive):
// - late tolerance t (0, 5, 10, 15 min): transit journeys arriving by meeting time + t; arriving
//   before the meeting time counts the wait until it; walk, bike, car leave when they want;
// - "first alone": the first one to arrive also counts the time until the second one arrives
//   (waiting with someone is not lost). Chosen for the group: the journeys of all are picked
//   together; nobody waits alone when someone comes by walk, bike or car (they can arrive with
//   the first one), nor when the first to arrive is a participant of several people.
// Only the transit and mixed configurations (cases.js): walk + bike do not depend on these rules.
// Usage: node scripts/eval/sensitivity.js [case id…]

import fs from 'fs';
import { CASES, CONFIGS, CATEGORY_SETS } from './cases.js';
import { CATEGORIES } from '../../js/engine.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { loadJourneys } from './journeys.js';
import { METRICS } from './scoring.js';

const CAR_PARKING_S = 5 * 60;
const TOLERANCES = [0, 5, 10, 15];
const REFERENCE = { tolerance: 10, firstAlone: false };
const VARIANTS = TOLERANCES.flatMap(tolerance => [false, true].map(firstAlone => ({ tolerance, firstAlone })));
const USELESS_S = 30 * 60; // a journey this much worse than a participant's best is never picked
const name = v => `${v.tolerance} min${v.firstAlone ? ' + 1er seul' : ''}`;

// A participant's options at a place: { cost, arrival (seconds from the meeting time, null when
// free: walk, bike, car) }
function options(p, i, j, oracle, journeys, tolerance) {
    const found = [];
    for (const mode of ['walk', 'bike', 'car']) {
        const t = p.modes.includes(mode) ? oracle.times[i][mode][j] : null;
        if (t != null) found.push({ cost: t + (mode === 'car' ? CAR_PARKING_S : 0), arrival: null });
    }
    if (p.modes.includes('transit') && journeys.journeys[i][j]) {
        const flat = journeys.journeys[i][j];
        for (let k = 0; k < flat.length; k += 2) {
            const [departure, arrival] = [flat[k], flat[k + 1]];
            if (arrival <= tolerance * 60) found.push({ cost: Math.max(arrival, 0) - departure, arrival: Math.max(arrival, 0) });
        }
    }
    if (!found.length) return found;
    const best = Math.min(...found.map(o => o.cost));
    return found.filter(o => o.cost <= best + USELESS_S);
}

// Score of one place under a variant (null if someone cannot reach it)
function placeScore(participants, opts, metric, firstAlone) {
    if (opts.some(o => !o.length)) return null;
    const people = participants.map(p => p.people);
    if (!firstAlone) return metric(opts.map(o => Math.min(...o.map(x => x.cost))), people);
    let best = Infinity;
    const pick = new Array(opts.length);
    (function choose(i) {
        if (i === opts.length) {
            const costs = pick.map(o => o.cost);
            if (pick.every(o => o.arrival != null)) {
                const order = pick.map((o, k) => k).sort((a, b) => pick[a].arrival - pick[b].arrival);
                const [first, second] = order;
                const alone = pick[second].arrival - pick[first].arrival;
                if (alone > 0 && people[first] === 1) costs[first] += alone;
            }
            best = Math.min(best, metric(costs, people));
            return;
        }
        for (const o of opts[i]) { pick[i] = o; choose(i + 1); }
    })(0);
    return best;
}

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);
const only = process.argv.slice(2).filter(a => CASES.some(c => c.id === a));
const rows = [];
let checked = 0;
let mismatches = 0;
for (const testCase of CASES.filter(c => !only.length || only.includes(c.id))) {
    const oracle = loadOracle(testCase.id);
    const journeys = loadJourneys(testCase.id);
    // The stored journeys give the oracle's exact transit time at 10 min (same rule as the tool)
    testCase.points.forEach((_, i) => places.forEach((_, j) => {
        const flat = journeys.journeys[i][j];
        if (!flat) return;
        let best = null;
        for (let k = 0; k < flat.length; k += 2) {
            if (flat[k + 1] <= 600) best = Math.min(best ?? Infinity, Math.max(flat[k + 1], 0) - flat[k]);
        }
        checked++;
        if ((best ?? null) !== (oracle.times[i].transit[j] ?? null)) mismatches++;
    }));
    for (const configName of ['transit', 'mixed']) {
        const participants = testCase.points.map((p, i) => ({ ...p, modes: CONFIGS[configName].modes(i) }));
        const scores = {}; // variant name -> metric -> [place] score
        for (const variant of VARIANTS) {
            const opts = places.map((_, j) => participants.map((p, i) => options(p, i, j, oracle, journeys, variant.tolerance)));
            scores[name(variant)] = Object.fromEntries(Object.entries(METRICS).map(([m, { score }]) =>
                [m, opts.map(o => placeScore(participants, o, score, variant.firstAlone))]));
        }
        for (const [setName, categories] of Object.entries(CATEGORY_SETS)) {
            const allowed = new Set(categories.flatMap(c => CATEGORIES[c]));
            const pool = places.map((_, j) => j).filter(j => allowed.has(places[j].category));
            for (const metricName of Object.keys(METRICS)) {
                const top = s => pool.filter(j => s[j] != null).sort((a, b) => s[a] - s[b]).slice(0, 3);
                const ref = scores[name(REFERENCE)][metricName];
                const refTop = top(ref);
                for (const variant of VARIANTS) {
                    const s = scores[name(variant)][metricName];
                    const varTop = top(s);
                    rows.push({
                        case: testCase.id, config: configName, categories: setName, metric: metricName, variant: name(variant),
                        same: varTop.filter(j => refTop.includes(j)).length, firstSame: varTop[0] === refTop[0],
                        // What the reference's first place loses under this variant's rule
                        regret: s[refTop[0]] == null ? null : (s[refTop[0]] - s[varTop[0]]) / 60,
                        best: s[varTop[0]] / 60,
                    });
                }
            }
        }
    }
    process.stderr.write(`${testCase.id} `);
}
process.stderr.write('\n');

console.log(`Check: stored journeys vs oracle transit times at 10 min: ${checked - mismatches}/${checked} identical\n`);
console.log('| règle | lignes | n° 1 identique | lieux communs au top 3 (moy.) | perte du n° 1 de référence : médiane / max (min) | meilleur score moyen (min) |');
console.log('|---|---|---|---|---|---|');
for (const variant of VARIANTS) {
    const r = rows.filter(x => x.variant === name(variant));
    const regrets = r.map(x => x.regret).filter(x => x != null).sort((a, b) => a - b);
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(`| ${name(variant)} | ${r.length} | ${Math.round(100 * r.filter(x => x.firstSame).length / r.length)} % `
        + `| ${mean(r.map(x => x.same)).toFixed(2)} / 3 | ${regrets[Math.floor(regrets.length / 2)].toFixed(1)} / ${regrets.at(-1).toFixed(1)} `
        + `| ${mean(r.map(x => x.best)).toFixed(1)} |`);
}
const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex > 0) fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(rows));
