// estimates.js - Is the estimate of the zones good enough off-peak? For other meeting times than the
// oracle's, every bar's exact transit time (transit.js as the tool, walking included as the fastest
// other mode), and each estimate used to shortlist the zones, then the method's result against the best
// bar. Bars only, walk + transit. Needs the local MOTIS; ~1 min per meeting time. Usage: node scripts/eval/estimates.js

import fs from 'fs';
import { CATEGORIES } from './common.js';
import { forEachLimited, transitTrip } from './common.js';
import { CASES } from './cases.js';
import { MOTIS_URL, streetDurations, transitDurationsTo } from './motis.js';
import { METRICS } from './scoring.js';

// Tuesday evening (the oracle's), off-peak on a weekday, late, and Sunday morning
const MEETINGS = [['2026-11-03', '19:00'], ['2026-11-03', '14:30'], ['2026-11-03', '22:00'], ['2026-11-08', '10:30']];
const TOLERANCE_MIN = 10;
const PROPOSALS = 3;
const SPACING_M = 500;
const PARALLEL = 16;
const SHORTLISTS = [10, 20];
const LEADS_MIN = [30, 60];

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const quantile = (xs, f) => [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))];
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const utc = (date, time) => new Date(`${date}T${time}:00+01:00`); // November: UTC+1

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const members = data.zones.map(() => []);
const bars = data.places.filter(p => CATEGORIES.bar.includes(p.category));
bars.forEach(p => members[p.zone].push(p));
const zones = data.zones.map((zone, i) => ({ ...zone, bars: members[i] })).filter(z => z.kind === 'bar');
zones.forEach(z => { z.rep = z.bars.reduce((b, p) => (dist(z, p) < dist(z, b) ? p : b)); });

async function forward(point, many, departure) {
    const res = await fetch(`${MOTIS_URL}/api/experimental/one-to-many-intermodal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ one: `${point.lat},${point.lon}`, many: many.map(p => `${p.lat},${p.lon}`), time: departure.toISOString(), arriveBy: false }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body.transit_durations.map(set => (set.length ? Math.min(...set.map(e => e.duration)) : null));
}

const rows = {};
for (const [date, time] of MEETINGS) {
    const label = `${date === '2026-11-08' ? 'dimanche' : 'mardi'} ${time}`;
    const end = new Date(utc(date, time).getTime() + TOLERANCE_MIN * 60000);
    const to = `${date} ${String(end.getUTCHours() + 1).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}`;
    for (const testCase of CASES) {
        const points = testCase.points;
        const people = points.map(p => p.people);
        const walk = await Promise.all(points.map(p => streetDurations('walk', p, bars)));
        const exact = points.map(() => new Array(bars.length).fill(null));
        const pairs = points.flatMap((_, i) => bars.map((_, j) => [i, j]));
        await forEachLimited(pairs, PARALLEL, async ([i, j]) => {
            const trip = await transitTrip(points[i], bars[j], `${date} ${time}`, to);
            if (trip) exact[i][j] = trip.seconds;
        });
        const index = new Map(bars.map((p, j) => [p.id, j]));
        const fastest = (i, j, transit) => {
            const options = [walk[i][j], transit].filter(t => t != null);
            return options.length ? Math.min(...options) : null;
        };
        const backward = points.map(() => new Map());
        await forEachLimited(zones, PARALLEL, async z => {
            (await transitDurationsTo(z.rep, points, end)).forEach((d, i) => backward[i].set(z.rep.id, d));
        });
        const estimators = { 'par zone (arrière)': (i, p) => backward[i].get(p.id) ?? null };
        for (const lead of LEADS_MIN) {
            const reps = zones.map(z => z.rep);
            const found = await Promise.all(points.map(p => forward(p, reps, new Date(utc(date, time).getTime() - lead * 60000))));
            const maps = found.map(list => new Map(reps.map((p, k) => [p.id, list[k]])));
            estimators[`par participant, ${lead} min avant`] = (i, p) => maps[i].get(p.id) ?? null;
        }
        for (const metric of Object.keys(METRICS)) {
            const scoreOf = (seconds) => (seconds.every(s => s != null) ? METRICS[metric].score(seconds, people) : null);
            const score = p => scoreOf(points.map((_, i) => fastest(i, index.get(p.id), exact[i][index.get(p.id)])));
            const ranked = list => list.filter(p => score(p) != null).sort((a, b) => score(a) - score(b));
            const all = ranked(bars);
            if (!all.length) continue;
            const best = score(all[0]);
            for (const [name, estimate] of Object.entries(estimators)) {
                const estimated = z => scoreOf(points.map((_, i) => fastest(i, index.get(z.rep.id), estimate(i, z.rep))));
                const order = zones.filter(z => estimated(z) != null).sort((a, b) => estimated(a) - estimated(b));
                for (const size of SHORTLISTS) {
                    const short = order.slice(0, size).filter(z => score(z.rep) != null).sort((a, b) => score(a.rep) - score(b.rep));
                    const kept = [];
                    for (const z of short) if (kept.length < PROPOSALS && kept.every(k => dist(k, z) >= SPACING_M)) kept.push(z);
                    if (!kept.length) { (rows[`${label}|${metric}|${name}|${size}`] ??= []).push({ first: Infinity, last: Infinity }); continue; }
                    const shown = kept.map(z => ranked(z.bars)[0]).sort((a, b) => score(a) - score(b));
                    (rows[`${label}|${metric}|${name}|${size}`] ??= []).push({ first: (score(shown[0]) - best) / 60, last: (score(shown[shown.length - 1]) - best) / 60 });
                }
            }
        }
    }
    process.stderr.write(`${label} `);
}
process.stderr.write('\n');
console.log('rendez-vous | score | estimation | zones exactes | groupes | n° 1 méd. / moy. / max | > 5 min | sans résultat | 3e moy.');
for (const [key, list] of Object.entries(rows)) {
    const first = list.map(r => r.first).filter(Number.isFinite);
    const last = list.map(r => r.last).filter(Number.isFinite);
    console.log(`${key.replaceAll('|', ' | ')} | ${list.length} | ${quantile(first, .5).toFixed(1)} / ${mean(first).toFixed(1)} / ${Math.max(...first).toFixed(1)} | ${first.filter(x => x > 5).length} | ${list.length - first.length} | ${mean(last).toFixed(1)}`);
}
