// baseline.js - The service's proposals on every case and configuration, for every place type, scored with the
// oracle's times (oracle.js) against the best places of the whole file. The questions go to the API, so what is measured
// is what is deployed: a middleware (API_URL, default http://localhost:8090) on a MOTIS with the same timetable as the
// oracle. The API refuses a past meeting time: build the oracle for a date to come, in a directory of its own, e.g.
//   EVAL_DATE=2026-11-17 EVAL_DIR=/tmp/oracle node scripts/eval/oracle.js T1
//   EVAL_DATE=2026-11-17 EVAL_DIR=/tmp/oracle node scripts/eval/baseline.js T1
// Each question claims another client address (X-Forwarded-For), so as not to meet the limits per client: a local
// middleware only, the deployed one sitting behind Caddy, which sets that header itself.
// Usage: node scripts/eval/baseline.js [case id…] [--json file]

import fs from 'fs';
import { CATEGORIES } from './common.js';
import { CASES, CONFIGS, DATE, SLOT } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { oracleScores, topPlaces } from './scoring.js';

const API_URL = process.env.API_URL || 'http://localhost:8090';
const CAR_PARKING_S = 5 * 60; // middleware/zones.go carParkingSeconds
const METRIC = 'half'; // the service's score
const PLACE_TYPES = ['bar', 'cafe', 'restaurant', 'station'];

let questions = 0;
async function askProposals(participants, placeType) {
    questions++;
    const res = await fetch(`${API_URL}/v1/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.${questions >> 16 & 255}.${questions >> 8 & 255}.${questions & 255}` },
        body: JSON.stringify({ meetingTime: `${DATE}T${SLOT}`, placeType,
            participants: participants.map(({ lat, lon, modes, people }) => ({ lat, lon, modes, people })) }),
    });
    const answer = await res.json();
    if (!res.ok) throw new Error(`API ${res.status}: ${answer.error}`);
    return answer;
}

const minutes = s => (s == null ? null : Math.round(s / 6) / 10);

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);
const rows = [];
const only = process.argv.slice(2).filter(a => CASES.some(c => c.id === a));
for (const testCase of CASES.filter(c => !only.length || only.includes(c.id))) {
    const oracle = loadOracle(testCase.id);
    if (oracle.date !== DATE) throw new Error(`the oracle of ${testCase.id} is for ${oracle.date}, not ${DATE}`);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    for (const configName of Object.keys(CONFIGS)) {
        const participants = testCase.points.map((point, i) => ({ ...point, modes: CONFIGS[configName].modes(i) }));
        const scores = oracleScores(oracle, participants, METRIC, CAR_PARKING_S);
        for (const placeType of PLACE_TYPES) {
            const answer = await askProposals(participants, placeType);
            const allowed = new Set(CATEGORIES[placeType]);
            const pool = places.map((p, j) => j).filter(j => allowed.has(places[j].category));
            const proposals = answer.proposals.map(k => scores[index.get(answer.places[k].id)]);
            const best = topPlaces(scores, pool, 3);
            const rankOf = s => (s == null ? null : pool.filter(j => scores[j] != null && scores[j] < s).length + 1);
            rows.push({
                case: testCase.id, config: configName, placeType,
                reachable: pool.filter(j => scores[j] != null).length,
                tool: proposals.map(minutes), best: best.map(j => minutes(scores[j])),
                gap: proposals[0] == null ? null : minutes(proposals[0] - scores[best[0]]),
                rank: rankOf(proposals[0]),
                bestPlace: places[best[0]]?.name,
            });
        }
    }
    process.stderr.write(`${testCase.id} `);
}
process.stderr.write('\n');

const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex > 0) fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ rows }, null, 1));

console.log('\n## Score : moyenne + ½ (max − moyenne), en minutes\n');
console.log('| cas | modes | lieux | service n°1 | meilleur | écart | rang | service top 3 | meilleurs 3 | meilleur lieu |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
    console.log(`| ${r.case} | ${r.config} | ${r.placeType} | ${r.tool[0] ?? '-'} | ${r.best[0] ?? '-'} | ${r.gap ?? '-'} | ${r.rank ?? '-'} / ${r.reachable} `
        + `| ${r.tool.join(', ')} | ${r.best.join(', ')} | ${r.bestPlace ?? '-'} |`);
}
