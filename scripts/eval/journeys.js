// journeys.js - The transit journeys themselves (departure and arrival times, not only the best
// time) of every participant of every case to every candidate place, to study the arrival rules
// without new calls (sensitivity.js): late tolerance from 0 to 15 min, waiting of the first one
// to arrive. Two local MOTIS /plan calls per pair, as transitous.js asks them (5 journeys with at
// least one transit leg): arriving by the meeting time, and by the meeting time + 15 min; their
// union holds the best journey of every tolerance from 0 to 15 min (checked against the oracle,
// see sensitivity.js). Written to EVAL_DIR/journeys-<case>.json: journeys[participant][place] =
// [departure, arrival, departure, arrival, …] in seconds from the meeting time.
// Usage: node scripts/eval/journeys.js [case id…] [--force]; ~4 min per case on a 16-core PC.

import fs from 'fs';
import path from 'path';
import { forEachLimited, parseParis } from './common.js';
import { MOTIS_URL } from './motis.js';
import { CASES, DATE, SLOT } from './cases.js';
import { EVAL_DIR, candidatePlaces } from './oracle.js';

const PARALLEL = 16;
const LATEST_MIN = 15; // the widest late tolerance studied
const PLAN_OPTIONS = { maxItineraries: 5, detailedTransfers: false }; // as transitous.js

export const journeysPath = id => path.join(EVAL_DIR, `journeys-${id}.json`);
export const loadJourneys = id => JSON.parse(fs.readFileSync(journeysPath(id)));

const meeting = parseParis(`${DATE} ${SLOT}`).getTime();

async function plan(from, to, arriveBy) {
    const params = new URLSearchParams({ fromPlace: `${from.lat},${from.lon}`, toPlace: `${to.lat},${to.lon}`,
        time: new Date(arriveBy).toISOString(), arriveBy: 'true', ...PLAN_OPTIONS });
    const res = await fetch(`${MOTIS_URL}/api/v6/plan?${params}`);
    if (!res.ok) throw new Error(`MOTIS plan ${res.status}`);
    return ((await res.json()).itineraries || [])
        .filter(it => it.legs.some(leg => leg.mode !== 'WALK'))
        .map(it => [(Date.parse(it.startTime) - meeting) / 1000, (Date.parse(it.endTime) - meeting) / 1000]);
}

async function buildJourneys(testCase, venues) {
    const journeys = testCase.points.map(() => new Array(venues.length).fill(null));
    let failures = 0;
    const pairs = testCase.points.flatMap((_, i) => venues.map((_, j) => [i, j]));
    await forEachLimited(pairs, PARALLEL, async ([i, j]) => {
        try {
            const found = [...await plan(testCase.points[i], venues[j], meeting),
                ...await plan(testCase.points[i], venues[j], meeting + LATEST_MIN * 60000)];
            const unique = [...new Map(found.map(([d, a]) => [`${d},${a}`, [d, a]])).values()];
            journeys[i][j] = unique.flat();
        } catch {
            failures++;
        }
    });
    return { case: testCase.id, venues: venues.map(v => v.id), journeys, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const ids = args.filter(a => !a.startsWith('--'));
    const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
    const venues = candidatePlaces(data);
    for (const testCase of CASES.filter(c => !ids.length || ids.includes(c.id))) {
        if (!force && fs.existsSync(journeysPath(testCase.id))) continue;
        const start = Date.now();
        const result = await buildJourneys(testCase, venues);
        fs.writeFileSync(journeysPath(testCase.id), JSON.stringify(result));
        console.log(`${testCase.id}: ${((Date.now() - start) / 1000).toFixed(0)} s, ${result.failures} failed pairs`);
    }
}
