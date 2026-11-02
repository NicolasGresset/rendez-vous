// clusters.js - Measures for the idea of proposing clusters of bars (not implemented), replayed on
// the stored oracle (oracle.js; no MOTIS needed): the clusters each rule makes, how interchangeable
// their members are, and a pipeline (spaced representatives scored, then the best member of the 3
// kept) against the 8 spaced candidates. Usage: node scripts/eval/clusters.js

import fs from 'fs';
import { CASES, CONFIGS } from './cases.js';
import { candidatePlaces, loadOracle } from './oracle.js';
import { oracleScores } from './scoring.js';

const rad = d => d * Math.PI / 180;
const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const centroid = ps => ({ lat: ps.reduce((s, p) => s + p.lat, 0) / ps.length, lon: ps.reduce((s, p) => s + p.lon, 0) / ps.length });
const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(f * (s.length - 1))] : NaN; };
const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const places = candidatePlaces(data);
const bars = places.filter(p => p.category === 'amenity=bar');

// Single linkage: chains (a street of bars 150 m apart can grow long)
function singleLink(ps, eps) {
    const parent = ps.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    ps.forEach((a, i) => ps.forEach((b, j) => { if (j > i && dist(a, b) <= eps) parent[find(i)] = find(j); }));
    const groups = new Map();
    ps.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
    return [...groups.values()];
}
// Complete linkage: every pair within maxDiameter, greedy merge of the closest compatible clusters
function completeLink(ps, maxDiameter) {
    let clusters = ps.map(p => [p]);
    const diameter = (a, b) => Math.max(...a.flatMap(x => b.map(y => dist(x, y))));
    for (;;) {
        let best = null;
        for (let i = 0; i < clusters.length; i++) {
            const ci = centroid(clusters[i]);
            for (let j = i + 1; j < clusters.length; j++) {
                if (dist(ci, centroid(clusters[j])) > maxDiameter) continue;
                const d = diameter(clusters[i], clusters[j]);
                if (d <= maxDiameter && (!best || d < best.d)) best = { i, j, d };
            }
        }
        if (!best) return clusters;
        clusters[best.i] = clusters[best.i].concat(clusters[best.j]);
        clusters.splice(best.j, 1);
    }
}
const diam = c => (c.length < 2 ? 0 : Math.max(...c.flatMap(x => c.map(y => dist(x, y)))));
const describe = (name, cs) => {
    const multi = cs.filter(c => c.length >= 3);
    const inMulti = multi.reduce((s, c) => s + c.length, 0);
    const top = [...cs].sort((a, b) => b.length - a.length).slice(0, 3)
        .map(c => `${c.length} bars/${Math.round(diam(c))} m`).join(', ');
    console.log(`${name}: ${cs.length} groupes dont ${multi.length} de >=3 bars (${inMulti}/${bars.length} bars), isolés ${cs.filter(c => c.length === 1).length}, diamètre max ${Math.round(Math.max(...cs.map(diam)))} m, plus gros: ${top}`);
};
console.log(`bars: ${bars.length}`);
const METHODS = {};
for (const eps of [100, 150, 200, 250, 300]) { METHODS[`chaînage ${eps} m`] = singleLink(bars, eps); describe(`chaînage ${eps} m`, METHODS[`chaînage ${eps} m`]); }
for (const d of [200, 300, 400]) { METHODS[`diamètre max ${d} m`] = completeLink(bars, d); describe(`diamètre max ${d} m`, METHODS[`diamètre max ${d} m`]); }

// Where are they: nearest place of the file naming the biggest clusters
const show = METHODS['diamètre max 300 m'].filter(c => c.length >= 3).sort((a, b) => b.length - a.length).slice(0, 12);
console.log('\nPlus gros groupes (diamètre max 300 m):');
for (const c of show) {
    const m = centroid(c);
    console.log(`  ${c.length} bars, ${Math.round(diam(c))} m, ${m.lat.toFixed(4)},${m.lon.toFixed(4)}: ${c.slice(0, 5).map(p => p.name).join(' / ')}${c.length > 5 ? ' …' : ''}`);
}

// Are members interchangeable? Within a cluster, spread of each person's time and of the score
const pairsFor = cs => cs.filter(c => c.length >= 3);
console.log('\nInterchangeabilité (groupes >=3 bars, score équitable, sur 30 cas x config, min):');
console.log('méthode | étendue du score dans le groupe méd/90%/max | par config transit, mixed, soft (méd/90%)');
const rowsBy = {};
for (const [name, cs] of Object.entries(METHODS)) {
    const by = { transit: [], mixed: [], soft: [] };
    for (const tc of CASES) {
        const oracle = loadOracle(tc.id);
        const index = new Map(oracle.venues.map((id, j) => [id, j]));
        for (const cfg of Object.keys(CONFIGS)) {
            const parts = tc.points.map((p, i) => ({ ...p, modes: CONFIGS[cfg].modes(i) }));
            const scores = oracleScores(oracle, parts, 'half', 300);
            for (const c of pairsFor(cs)) {
                const v = c.map(p => scores[index.get(p.id)]).filter(x => x != null);
                if (v.length >= 2) by[cfg].push((Math.max(...v) - Math.min(...v)) / 60);
            }
        }
    }
    const all = Object.values(by).flat();
    console.log(`${name} | ${q(all, .5).toFixed(1)} / ${q(all, .9).toFixed(1)} / ${q(all, 1).toFixed(1)} | `
        + Object.values(by).map(v => `${q(v, .5).toFixed(1)}/${q(v, .9).toFixed(1)}`).join(', '));
    rowsBy[name] = by;
}

// Pipeline on bars: pick a representative per cluster, score only those (8 or more), keep 3 clusters
// spaced by construction, then show each cluster's best member. Compared with the tool's rule.
function spaced(pool, c, spacing, wanted) {
    const sorted = pool.map(p => ({ p, d: dist(c, p) })).sort((a, b) => a.d - b.d);
    let r = 1000, out = [];
    for (;;) {
        out = [];
        for (const { p, d } of sorted) { if (d > r) break; if (out.length < wanted && out.every(x => dist(x, p) >= spacing)) out.push(p); }
        if (out.length >= wanted || r >= 5000) return out;
        r += 500;
    }
}
const center = pts => {
    const n = pts.reduce((s, p) => s + p.people, 0);
    return { lat: pts.reduce((s, p) => s + p.people * p.lat, 0) / n, lon: pts.reduce((s, p) => s + p.people * p.lon, 0) / n };
};
console.log('\nPipeline bars seuls, score équitable, 30 lignes:');
console.log('variante | n°1 moy/max vs meilleur fichier | >5 min | dernier proposé moy | appels: lieux évalués moy');
function report(name, rows) {
    const g = rows.map(r => r.gap1).filter(x => x != null);
    console.log(`${name} | ${avg(g).toFixed(1)} / ${Math.max(...g).toFixed(1)} | ${g.filter(x => x > 5).length} | ${avg(rows.map(r => r.gap3)).toFixed(1)} | ${avg(rows.map(r => r.n)).toFixed(1)}`);
}
const variants = {};
const add = (name, row) => (variants[name] ??= []).push(row);
const clustersFor = METHODS['diamètre max 300 m'];
for (const tc of CASES) {
    const oracle = loadOracle(tc.id);
    const index = new Map(oracle.venues.map((id, j) => [id, j]));
    const c = center(tc.points);
    for (const cfg of Object.keys(CONFIGS)) {
        const parts = tc.points.map((p, i) => ({ ...p, modes: CONFIGS[cfg].modes(i) }));
        const scores = oracleScores(oracle, parts, 'half', 300);
        const sc = p => scores[index.get(p.id)];
        const best = Math.min(...bars.map(sc).filter(x => x != null));
        const top3 = list => list.filter(p => sc(p) != null).sort((a, b) => sc(a) - sc(b)).slice(0, 3);
        const rec = (name, chosen, n) => add(name, { gap1: chosen[0] ? (sc(chosen[0]) - best) / 60 : null, gap3: chosen.length ? (sc(chosen[chosen.length - 1]) - best) / 60 : 0, n });
        rec('espacés 700 m', top3(spaced(bars, c, 700, 8)), 8);
        // Representative of a cluster: its member closest to the centroid. Scored: spaced representatives
        const reps = clustersFor.map(cl => { const m = centroid(cl); return { ...cl.reduce((b, p) => (dist(m, p) < dist(m, b) ? p : b)), cluster: cl }; });
        const big = reps.filter(r => r.cluster.length >= 3);
        for (const [label, pool] of [['clusters >=3 seulement', big], ['clusters + bars isolés', reps]]) {
            const picked = spaced(pool, c, 700, 8);
            const ranked = picked.filter(p => sc(p) != null).sort((a, b) => sc(a) - sc(b)).slice(0, 3);
            rec(`${label}: représentant`, ranked, 8);
            // Second round: every member of the 3 clusters kept gets its exact time
            const refined = ranked.map(r => r.cluster.filter(p => sc(p) != null).reduce((b, p) => (sc(p) < sc(b) ? p : b)));
            rec(`${label}: meilleur membre des 3`, refined.sort((a, b) => sc(a) - sc(b)),
                8 + ranked.reduce((s, r) => s + r.cluster.length - 1, 0));
        }
    }
}
for (const [name, rows] of Object.entries(variants)) report(name, rows);
