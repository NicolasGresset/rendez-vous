// oracle.js - Exact travel times of every participant of every case (cases.js) to every candidate
// place of data/pois-toulouse.json, from a local MOTIS server (motis.js): walk, bike, car (raw,
// without the parking time), and transit computed as the tool does (transitous.js transitTrip:
// /plan arriving by the end of the slot, an early arrival counting the wait until it starts).
// Also transitEstimate: MOTIS one-to-many durations for an arrival at the end of the slot (one
// call per place for all participants, ~100x cheaper; it counts the time up to the end of the
// slot, so 0 to TOLERANCE_MIN more, plus ~2 min), kept to try cheap filtering methods.
// Written to EVAL_DIR/oracle-<case>.json (default ~/motis/eval), reused when present.
// Usage: node scripts/eval/oracle.js [case id…] [--force]
// ~5 min per case on a 16-core PC: one /plan call per participant and place (~20 ms each), one
// one-to-many call per place, one street call per participant and mode.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CATEGORIES } from '../../js/engine.js';
import { parseParis, forEachLimited, transitTrip } from '../../js/transitous.js';
import { MOTIS_URL, streetDurations, transitDurationsTo } from './motis.js';
import { CASES, DATE, SLOT, TOLERANCE_MIN } from './cases.js';

export const EVAL_DIR = process.env.EVAL_DIR || path.join(os.homedir(), 'motis', 'eval');
const PARALLEL = 16;
const SLOT_TO = SLOT.replace(/\d+$/, m => String(Number(m) + TOLERANCE_MIN).padStart(2, '0'));

// transitous.js calls Transitous: sent to the local server instead
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).replace('https://api.transitous.org', MOTIS_URL), init);

// Candidate places (the categories engine.js can pick from), in file order
export function candidatePlaces(data) {
    const categories = new Set(Object.values(CATEGORIES).flat());
    return data.places.filter(p => categories.has(p.category));
}

export const slotEnd = () => new Date(parseParis(`${DATE} ${SLOT}`).getTime() + TOLERANCE_MIN * 60000);
export const oraclePath = id => path.join(EVAL_DIR, `oracle-${id}.json`);

// { venues: [id], times: [participant][mode][venue] seconds or null, failures }
async function buildOracle(testCase, venues) {
    const points = testCase.points;
    const empty = () => new Array(venues.length).fill(null);
    const times = points.map(() => ({ walk: [], bike: [], car: [], transit: empty(), transitEstimate: empty() }));
    for (const [i, point] of points.entries()) {
        for (const mode of ['walk', 'bike', 'car']) times[i][mode] = await streetDurations(mode, point, venues);
    }
    const arriveBy = slotEnd();
    await forEachLimited(venues.map((v, j) => j), PARALLEL, async j => {
        const durations = await transitDurationsTo(venues[j], points, arriveBy);
        durations.forEach((d, i) => { times[i].transitEstimate[j] = d; });
    });
    let failures = 0;
    const pairs = points.flatMap((_, i) => venues.map((_, j) => [i, j]));
    await forEachLimited(pairs, PARALLEL, async ([i, j]) => {
        try {
            const trip = await transitTrip(points[i], venues[j], `${DATE} ${SLOT}`, `${DATE} ${SLOT_TO}`);
            times[i].transit[j] = trip ? trip.seconds : null;
        } catch (err) {
            failures++;
        }
    });
    return { case: testCase.id, date: DATE, slot: SLOT, venues: venues.map(v => v.id), times, failures };
}

export function loadOracle(id) {
    return JSON.parse(fs.readFileSync(oraclePath(id)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const ids = args.filter(a => !a.startsWith('--'));
    const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
    const venues = candidatePlaces(data);
    fs.mkdirSync(EVAL_DIR, { recursive: true });
    for (const testCase of CASES.filter(c => !ids.length || ids.includes(c.id))) {
        if (!force && fs.existsSync(oraclePath(testCase.id))) continue;
        const start = Date.now();
        const oracle = await buildOracle(testCase, venues);
        fs.writeFileSync(oraclePath(testCase.id), JSON.stringify(oracle));
        const missing = mode => oracle.times.map(t => t[mode].filter(x => x == null).length).join(' / ');
        console.log(`${testCase.id}: ${venues.length} places in ${((Date.now() - start) / 1000).toFixed(0)} s, `
            + `${oracle.failures} failed calls; no time: transit ${missing('transit')}, walk ${missing('walk')}, `
            + `bike ${missing('bike')}, car ${missing('car')}`);
    }
}
