// baseline.js - The tool's own method (engine.js evaluate: candidates around the barycenter, exact
// times to them, ranking) run on every case and configuration, its proposals then scored with the
// oracle's times (oracle.js) against the best places of the whole file. evaluate() runs unchanged:
// its Transitous calls go to the local MOTIS server, its openrouteservice matrices are answered
// with MOTIS street durations (so that both sides use the same times), directions are refused.
// Usage: node scripts/eval/baseline.js [case id…] [--json file]

import fs from 'fs';
import { evaluate, rankCandidates, SCORES, CATEGORIES } from '../../js/engine.js';
import { CASES, CONFIGS, CATEGORY_SETS, DATE, SLOT } from './cases.js';
import { MOTIS_URL, streetDurations } from './motis.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { METRICS, oracleScores, topPlaces } from './scoring.js';

const DATA_URL = new URL('../../data/pois-toulouse.json', import.meta.url);
const CAR_PARKING_S = 5 * 60; // as engine.js

// ---- evaluate() outside the browser ----

// Fixed clock: evaluate() computes for "today" in Toulouse
const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [`${DATE}T12:00:00Z`])); }
    static now() { return new RealDate(`${DATE}T12:00:00Z`).getTime(); }
};

const realFetch = globalThis.fetch;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'data/pois-toulouse.json') return new Response(fs.readFileSync(DATA_URL));
    if (url.startsWith(MOTIS_URL)) return realFetch(input, init);
    if (url.startsWith('https://api.transitous.org/')) return realFetch(url.replace('https://api.transitous.org', MOTIS_URL), init);
    const matrix = url.match(/^https:\/\/api\.openrouteservice\.org\/v2\/matrix\/([\w-]+)$/);
    if (matrix) {
        const mode = { 'foot-walking': 'walk', 'cycling-regular': 'bike', 'driving-car': 'car' }[matrix[1]];
        const { locations, sources, destinations } = JSON.parse(init.body);
        const point = ([lon, lat]) => ({ lat, lon });
        const targets = destinations.map(k => point(locations[k]));
        const durations = await Promise.all(sources.map(k => streetDurations(mode, point(locations[k]), targets)));
        return reply({ durations });
    }
    if (url.startsWith('https://api.openrouteservice.org/')) return reply({ error: 'not in the evaluation' }, 503);
    throw new Error(`unexpected fetch: ${url}`);
};
// evaluate() logs the refused directions; nothing else is expected there
console.error = () => {};

// Register the evaluation's metrics with engine.js, so that its ranking can use them
for (const [name, metric] of Object.entries(METRICS)) SCORES[name] = metric.score;

async function runTool(testCase, configName, categories, data) {
    const participants = testCase.points.map((point, i) => ({ ...point, modes: CONFIGS[configName].modes(i) }));
    const calls = { orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0 };
    let result = null;
    await evaluate({ participants, slot: SLOT, categories, transitEngine: 'transitous', metric: 'mean' },
        { ors: 'evaluation' }, data, calls, event => { if (event.type === 'result') result = event; });
    return { participants, result, calls };
}

// ---- comparison ----

const km = (a, b) => {
    const rad = d => d * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const minutes = s => (s == null ? null : Math.round(s / 6) / 10);

const data = JSON.parse(fs.readFileSync(DATA_URL));
const places = candidatePlaces(data);
const rows = [];
const transitPairs = []; // [tool's /plan time, oracle time] for the same participant and place
const only = process.argv.slice(2).filter(a => CASES.some(c => c.id === a));
for (const testCase of CASES.filter(c => !only.length || only.includes(c.id))) {
    const oracle = loadOracle(testCase.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    for (const configName of Object.keys(CONFIGS)) {
        for (const [setName, categories] of Object.entries(CATEGORY_SETS)) {
            const { participants, result } = await runTool(testCase, configName, categories, data);
            const allowed = new Set(categories.flatMap(c => CATEGORIES[c]));
            const pool = places.map((p, j) => j).filter(j => allowed.has(places[j].category));
            const people = participants.map(p => p.people);
            for (const c of result.candidates) {
                participants.forEach((p, i) => {
                    const tool = c.times[i].transit?.seconds;
                    const exact = oracle.times[i].transit[index.get(c.id)];
                    if (tool != null && exact != null) transitPairs.push([tool, exact]);
                });
            }
            for (const metricName of Object.keys(METRICS)) {
                const scores = oracleScores(oracle, participants, metricName, CAR_PARKING_S);
                const ranking = rankCandidates(result.candidates, metricName, people).slice(0, 3);
                const proposals = ranking.map(k => scores[index.get(result.candidates[k].id)]);
                const best = topPlaces(scores, pool, 3);
                const rankOf = s => (s == null ? null : pool.filter(j => scores[j] != null && scores[j] < s).length + 1);
                const bestPlace = places[best[0]];
                rows.push({
                    case: testCase.id, config: configName, categories: setName, metric: metricName,
                    candidates: result.candidates.length,
                    reachable: pool.filter(j => scores[j] != null).length,
                    tool: proposals.map(minutes), best: best.map(j => minutes(scores[j])),
                    gap: proposals[0] == null ? null : minutes(proposals[0] - scores[best[0]]),
                    rank: rankOf(proposals[0]),
                    bestPlace: bestPlace.name, bestCategory: bestPlace.category,
                    centerToBestKm: Math.round(km(result.center, bestPlace) * 10) / 10,
                });
            }
        }
    }
    process.stderr.write(`${testCase.id} `);
}
process.stderr.write('\n');

const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex > 0) fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ rows, transitPairs }, null, 1));

for (const metricName of Object.keys(METRICS)) {
    console.log(`\n## Score: ${METRICS[metricName].label} (minutes)\n`);
    console.log('| cas | modes | lieux | outil n°1 | meilleur | écart | rang | outil top 3 | meilleurs 3 | meilleur lieu | centre → meilleur |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows.filter(x => x.metric === metricName)) {
        console.log(`| ${r.case} | ${r.config} | ${r.categories} | ${r.tool[0] ?? '-'} | ${r.best[0]} | ${r.gap ?? '-'} | ${r.rank ?? '-'} / ${r.reachable} `
            + `| ${r.tool.join(', ')} | ${r.best.join(', ')} | ${r.bestPlace} | ${r.centerToBestKm} km |`);
    }
}
const diffs = transitPairs.map(([tool, exact]) => (tool - exact) / 60).sort((a, b) => a - b);
const q = f => diffs[Math.floor(f * (diffs.length - 1))].toFixed(1);
console.log(`\nTransit, tool (/plan) - oracle (one-to-many), ${diffs.length} pairs: `
    + `min ${q(0)}, 10 % ${q(0.1)}, median ${q(0.5)}, 90 % ${q(0.9)}, max ${q(1)} min`);
