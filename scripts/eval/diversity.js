// diversity.js - Rules to spread the evaluated candidates and the proposals, replayed on the stored
// oracle (oracle.js; no MOTIS needed, 2 s): the former rule ("actuel", the closest places), minimum
// spacings, farthest-point selection, the whole file; each with a minimum distance between the 3
// proposals. Its own copy of the selection, since it compares rules: baseline.js runs the tool's.
// Usage: node scripts/eval/diversity.js

import fs from 'fs';
import { CATEGORIES } from '../../js/engine.js';
import { CASES, CONFIGS, CATEGORY_SETS } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { METRICS, oracleScores } from './scoring.js';

const CAR = 300, TOTAL = 8;
const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const quotasFor = cats => Object.fromEntries(cats.map((c, i) => [c, Math.floor(TOTAL / cats.length) + (i < TOTAL % cats.length ? 1 : 0)]));
const center = pts => {
    const n = pts.reduce((s, p) => s + p.people, 0);
    return { lat: pts.reduce((s, p) => s + p.people * p.lat, 0) / n, lon: pts.reduce((s, p) => s + p.people * p.lon, 0) / n };
};
function nearby(pool, c, r) {
    const seen = new Set();
    return pool.map(p => ({ ...p, distance: dist(c, p) })).filter(p => p.distance <= r)
        .sort((a, b) => a.distance - b.distance)
        .filter(p => !seen.has(`${p.category}:${p.name}`) && seen.add(`${p.category}:${p.name}`));
}
// Same rule as engine.js candidatesWithin, with an optional minimum spacing between chosen places
function nearest(pool, c, cats, r, spacing) {
    const near = nearby(pool, c, r), quotas = quotasFor(cats), chosen = [];
    const ok = p => chosen.every(q => dist(p, q) >= spacing);
    for (const cat of cats) {
        const list = near.filter(p => CATEGORIES[cat].includes(p.category));
        let left = quotas[cat];
        if (cat === 'station') {
            let metros = Math.ceil(left / 2);
            for (const p of list) if (p.category === 'metro' && metros > 0 && ok(p)) { chosen.push(p); metros--; left--; }
        }
        for (const p of list) if (left > 0 && !chosen.includes(p) && ok(p)) { chosen.push(p); left--; }
    }
    return chosen;
}
// Current behaviour: radius grows until 3 are found. Spaced: until all 8 are found
function grow(pool, c, cats, spacing, wanted) {
    let r = 1000, out = nearest(pool, c, cats, r, spacing);
    while (out.length < wanted && r < 5000) { r += 500; out = nearest(pool, c, cats, r, spacing); }
    return out;
}
// Farthest-point within a fixed disk, seeded by the closest, quotas kept
function farthest(pool, c, cats, r) {
    const near = nearby(pool, c, r), quotas = quotasFor(cats), chosen = [];
    for (const cat of cats) {
        const list = near.filter(p => CATEGORIES[cat].includes(p.category));
        for (let k = 0; k < quotas[cat] && list.length; k++) {
            const pick = chosen.length ? list.filter(p => !chosen.includes(p)).reduce((b, p) => {
                const m = Math.min(...chosen.map(q => dist(p, q)));
                return !b || m > b.m ? { p, m } : b;
            }, null)?.p : list[0];
            if (pick) chosen.push(pick);
        }
    }
    return chosen;
}
const STRATEGIES = {
    'actuel (8 plus proches)': (pool, c, cats) => grow(pool, c, cats, 0, 3),
    'espacés 300 m': (pool, c, cats) => grow(pool, c, cats, 300, TOTAL),
    'espacés 500 m': (pool, c, cats) => grow(pool, c, cats, 500, TOTAL),
    'espacés 700 m': (pool, c, cats) => grow(pool, c, cats, 700, TOTAL),
    'espacés 800 m': (pool, c, cats) => grow(pool, c, cats, 800, TOTAL),
    'espacés 1200 m': (pool, c, cats) => grow(pool, c, cats, 1200, TOTAL),
    'max-min disque 1,5 km': (pool, c, cats) => farthest(pool, c, cats, 1500),
    'max-min disque 2,5 km': (pool, c, cats) => farthest(pool, c, cats, 2500),
    'tout le fichier (réf. serveur)': pool => pool,
};
const SEPARATIONS = [0, 300, 500, 700];

function proposals(list, D) {
    const out = [];
    for (const p of list) if (out.length < 3 && out.every(q => dist(p, q) >= D)) out.push(p);
    return out;
}
const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);
const results = {};
let unmatched = 0;
for (const tc of CASES) {
    const oracle = loadOracle(tc.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    unmatched += places.filter(p => !index.has(p.id)).length;
    const c = center(tc.points);
    for (const configName of Object.keys(CONFIGS)) {
        const participants = tc.points.map((p, i) => ({ ...p, modes: CONFIGS[configName].modes(i) }));
        for (const [setName, cats] of Object.entries(CATEGORY_SETS)) {
            const allowed = new Set(cats.flatMap(x => CATEGORIES[x]));
            const pool = places.filter(p => allowed.has(p.category));
            for (const metric of Object.keys(METRICS)) {
                const scores = oracleScores(oracle, participants, metric, CAR);
                const sc = p => scores[index.get(p.id)];
                const bestOf = Math.min(...pool.map(sc).filter(x => x != null));
                for (const [name, strat] of Object.entries(STRATEGIES)) {
                    const cand = strat(pool, c, cats);
                    const ranked = cand.filter(p => sc(p) != null).sort((a, b) => sc(a) - sc(b));
                    const far = Math.max(...cand.map(p => dist(c, p)));
                    for (const D of SEPARATIONS) {
                        const prop = proposals(ranked, D);
                        let minD = Infinity;
                        prop.forEach((a, i) => prop.slice(i + 1).forEach(b => { minD = Math.min(minD, dist(a, b)); }));
                        const key = `${metric}|${setName}|${name}|${D}`;
                        (results[key] ??= []).push({
                            cfg: configName, n: cand.length, far,
                            gap1: prop[0] ? (sc(prop[0]) - bestOf) / 60 : null,
                            gap3: prop.length ? (sc(prop[prop.length - 1]) - bestOf) / 60 : null,
                            spread3: prop.length ? (sc(prop[prop.length - 1]) - sc(prop[0])) / 60 : null,
                            minD: prop.length > 1 ? minD : null, count: prop.length,
                        });
                    }
                }
            }
        }
    }
}
const q = (xs, f) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
const avg = xs => { const s = xs.filter(x => x != null); return s.reduce((a, b) => a + b, 0) / s.length; };
const f1 = x => x.toFixed(1);
console.log('places absent from the oracle (all cases):', unmatched);
for (const metric of Object.keys(METRICS)) for (const setName of Object.keys(CATEGORY_SETS)) {
    console.log(`\n## ${metric} / ${setName}`);
    console.log('stratégie | sép. | gap1 méd/moy/max | >5min | gap3 moy | n°3-n°1 moy | dist min méd m | <300m | <3 props | cand. moy | loin méd km');
    for (const name of Object.keys(STRATEGIES)) for (const D of SEPARATIONS) {
        const r = results[`${metric}|${setName}|${name}|${D}`];
        console.log([name, D,
            `${f1(q(r.map(x => x.gap1), .5))}/${f1(avg(r.map(x => x.gap1)))}/${f1(q(r.map(x => x.gap1), 1))}`,
            r.filter(x => x.gap1 > 5).length, f1(avg(r.map(x => x.gap3))), f1(avg(r.map(x => x.spread3))),
            Math.round(q(r.map(x => x.minD), .5)), r.filter(x => x.minD != null && x.minD < 300).length,
            r.filter(x => x.count < 3).length, f1(avg(r.map(x => x.n))), f1(q(r.map(x => x.far), .5) / 1000)].join(' | '));
    }
}
// Per configuration, default score, both sets
console.log('\n## half, par configuration (gap1 méd/moy/max, sép. 0)');
for (const name of Object.keys(STRATEGIES)) for (const cfg of Object.keys(CONFIGS)) {
    const r = Object.keys(CATEGORY_SETS).flatMap(s => results[`half|${s}|${name}|0`]).filter(x => x.cfg === cfg);
    console.log(`${name} | ${cfg} | ${f1(q(r.map(x => x.gap1), .5))}/${f1(avg(r.map(x => x.gap1)))}/${f1(q(r.map(x => x.gap1), 1))}`);
}
