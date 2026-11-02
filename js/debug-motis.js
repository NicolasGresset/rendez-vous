// debug-motis.js - With the local MOTIS (motis.js): the method by zones (evaluateByZones, shown in the
// practical view, until the home server runs it), and for the debug view every candidate place of
// the picked categories, not only those around the barycenter, with each participant's times, to compare the
// tool's proposals with the best places of the whole file (as scripts/eval does offline).
// Street times are exact (one call per participant and mode). Transit: exact for every place up
// to EXACT_ALL_MAX places; beyond, a cheap estimate for every place (one call per place for all
// participants, 0 to 15 min too long) and exact times for the EXACT_SHORTLIST best of each score.

import * as motis from './motis.js';
import { CATEGORIES, SCORES, computationBase, haversine, placeRoutes } from './engine.js';
import { forEachLimited, parseParis } from './transitous.js';
import { PROPOSALS } from './results.js';

const EXACT_ALL_MAX = 600;
const EXACT_SHORTLIST = 100;
const PARALLEL = 8;
const CAR_PARKING_S = 5 * 60; // as engine.js
const STREET_MODES = ['walk', 'bike', 'car'];
const ZONE_SHORTLIST = 20;      // zones scored exactly after the estimate of every zone
// Between the zones kept: neighbouring zones are often the best 3. Measured on Toulouse's bars: the
// value is to be measured again on other data (docs/evaluation.md § Around which center)
const ZONE_SPACING_M = 500;

// The running batch of calls of this file, cancelled when its result is no longer wanted: a
// computation still running must not keep the page waiting for it
let batch = new AbortController();
export const cancelBatch = () => batch.abort();
export const beginBatch = () => { if (batch.signal.aborted) batch = new AbortController(); };

// participants: [{ lat, lon, modes, people }], slot: { from, to } ("YYYY-MM-DD HH:MM", as in the
// result event); onProgress(text). Returns { places: [{ ...place, times: [{ mode: seconds }],
// estimated: transit times not all exact }], estimated (count) }
export async function enumeratePlaces(participants, categories, slot, data, onProgress) {
    const allowed = new Set(categories.flatMap(c => CATEGORIES[c]));
    const places = data.places.filter(p => allowed.has(p.category)).map(p => toScore(p, participants));

    onProgress(`temps marche, vélo, voiture vers ${places.length} lieux…`);
    await streetTimes(participants, places);

    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    let exactPlaces = places.map((_, j) => j);
    if (transit.length && places.length > EXACT_ALL_MAX) {
        let done = 0;
        const arriveBy = parseParis(slot.to);
        await forEachLimited(places.map((_, j) => j), PARALLEL, async j => {
            const estimates = await motis.transitEstimates(places[j], transit.map(i => participants[i]), arriveBy, batch.signal);
            estimates.forEach((d, k) => { if (d != null) places[j].times[transit[k]].transit = d; });
            places[j].estimated = true;
            if (++done % 200 === 0) onProgress(`estimation bus/métro : ${done}/${places.length} lieux`);
        });
        const people = participants.map(p => p.people);
        const shortlist = new Set();
        Object.keys(SCORES).forEach(metric => {
            scorePlaces(places, metric, people).slice(0, EXACT_SHORTLIST).forEach(j => shortlist.add(j));
        });
        exactPlaces = [...shortlist];
    }
    await exactTransit(participants, places, exactPlaces, slot, onProgress);
    return { places, estimated: places.filter(p => p.estimated).length };
}

// A place of the file with room for its times
const toScore = (p, participants) => ({ ...p, times: participants.map(() => ({})), waits: participants.map(() => 0),
    trips: participants.map(() => null), estimated: false });

// Street times of every participant to every place
async function streetTimes(participants, places) {
    await Promise.all(participants.flatMap((p, i) => STREET_MODES.filter(m => p.modes.includes(m)).map(async mode => {
        const durations = await motis.streetDurations(mode, p, places, batch.signal);
        durations.forEach((d, j) => {
            if (d != null) places[j].times[i][mode] = Math.round(d + (mode === 'car' ? CAR_PARKING_S : 0));
        });
    })));
}

// Exact transit journeys to the places of these indices; returns how many were asked. keepTrips:
// each place also keeps its journeys, to show them
async function exactTransit(participants, places, indices, slot, onProgress, keepTrips = false) {
    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    const pairs = indices.flatMap(j => transit.map(i => [i, j]));
    let done = 0;
    await forEachLimited(pairs, PARALLEL, async ([i, j]) => {
        const trip = await motis.trip(participants[i], places[j], slot.from, slot.to, batch.signal);
        if (trip) {
            places[j].times[i].transit = trip.seconds;
            places[j].waits[i] = trip.wait;
            if (keepTrips) places[j].trips[i] = trip;
        } else {
            delete places[j].times[i].transit;
        }
        if (++done % 100 === 0) onProgress(`trajets bus/métro exacts : ${done}/${pairs.length}`);
    });
    indices.forEach(j => { places[j].estimated = false; });
    return pairs.length;
}

// The method with the zones of the data file (scripts/build-zones.js), coarse then finer: every
// zone's representative estimated, the ZONE_SHORTLIST best exact, the PROPOSALS best zones at least
// ZONE_SPACING_M apart, then every place of these zones exact; a zone's best place makes its rank.
// Stations have no zones. No richer zone is favoured. Returns null without bars, cafés nor restaurants, or
// { zones: [{ kind, name, lat, lon, places: best first }], spacing, estimated, exact, journeys, seconds }
export async function scoreZones(participants, categories, slot, data, metric, onProgress) {
    const kinds = categories.filter(c => c !== 'station');
    if (!kinds.length) return null;
    const started = performance.now();
    const people = participants.map(p => p.people);
    const members = data.zones.map(() => []);
    data.places.forEach(p => { if (p.zone != null) members[p.zone].push(p); });
    // A zone's position is its representative's
    const closestMember = (zone, index) => members[index].reduce((best, p) =>
        (haversine(zone, p) < haversine(zone, best) ? p : best));
    const reps = data.zones.flatMap((zone, index) => (kinds.includes(zone.kind)
        ? [toScore(closestMember(zone, index), participants)] : []));

    onProgress(`zones : estimation de ${reps.length} représentants…`);
    await streetTimes(participants, reps);
    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    if (transit.length) {
        const arriveBy = parseParis(slot.to);
        await forEachLimited(reps.map((_, j) => j), PARALLEL, async j => {
            const estimates = await motis.transitEstimates(reps[j], transit.map(i => participants[i]), arriveBy, batch.signal);
            estimates.forEach((d, k) => { if (d != null) reps[j].times[transit[k]].transit = d; });
        });
    }

    const shortlist = scorePlaces(reps, metric, people).slice(0, ZONE_SHORTLIST).map(j => reps[j]);
    onProgress(`zones : ${shortlist.length} représentants en temps exact…`);
    let journeys = await exactTransit(participants, shortlist, shortlist.map((_, j) => j), slot, onProgress, true);
    const kept = [];
    for (const j of scorePlaces(shortlist, metric, people)) {
        const zone = shortlist[j];
        if (kept.length < PROPOSALS && kept.every(k => haversine(k, zone) >= ZONE_SPACING_M)) kept.push(zone);
    }

    // Second round: the other places of the zones kept, the representatives' times being known
    const others = kept.flatMap(rep => members[rep.zone].filter(p => p.id !== rep.id).map(p => toScore(p, participants)));
    onProgress(`zones : ${others.length} autres lieux des ${kept.length} meilleures…`);
    if (others.length) {
        await streetTimes(participants, others);
        journeys += await exactTransit(participants, others, others.map((_, j) => j), slot, onProgress, true);
    }
    const scored = [...kept, ...others];
    const ranking = scorePlaces(scored, metric, people);
    const zones = kept.map(rep => ({
        ...data.zones[rep.zone],
        places: ranking.map(j => scored[j]).filter(p => p.zone === rep.zone),
    })).sort((a, b) => a.places[0].score - b.places[0].score);
    return { zones, spacing: ZONE_SPACING_M, estimated: reps.length, exact: shortlist.length, journeys,
        seconds: (performance.now() - started) / 1000 };
}

// The method by zones as a computation of the engine (engine.js evaluate: same events, same
// candidates): the candidates are the places of the zones kept, each zone's best first (the
// proposals), each with its `zoneInfo`. Stops at the first failed journey; cancelled by cancelBatch
export async function evaluateByZones({ participants, slot, categories, metric }, data, calls, emit) {
    beginBatch();
    const base = computationBase(participants, slot);
    emit({ type: 'start', ...base });
    const found = await scoreZones(participants, categories, base.slot, data, metric,
        text => emit({ type: 'zones', text }));
    const places = found.zones.map(zone => zone.places).sort((a, b) => a[0].score - b[0].score);
    const inOrder = [...places.map(list => list[0]), ...places.flatMap(list => list.slice(1))];
    const candidates = inOrder.map(p => toCandidate(p, participants, data));
    const ranking = candidates.map((_, j) => j);
    const best = candidates.length ? 0 : null;
    emit({ type: 'result', ...base, candidates, ranking, proposals: ranking.slice(0, places.length), best, metric });
    if (best != null) await placeRoutes(participants, candidates[best], {}, calls, emit, 'motis');
    emit({ type: 'done' });
}

// A place scored here in the shape of the engine's candidates
function toCandidate(p, participants, data) {
    const times = p.times.map((modeTimes, i) => Object.fromEntries(Object.entries(modeTimes).map(([mode, seconds]) =>
        [mode, mode === 'transit' ? { seconds, trip: p.trips[i] } : { seconds }])));
    const { name, kind } = data.zones[p.zone];
    return { ...p, times, incomplete: false, zoneInfo: { index: p.zone, name, kind },
        total: p.choices.reduce((sum, c, i) => sum + participants[i].people * c.seconds, 0) };
}

// Each place's fastest time per participant ({ mode, seconds } or null) and score for the metric
// (null when someone cannot reach it); returns the indices of the reachable places, best first
export function scorePlaces(places, metric, people) {
    places.forEach(p => {
        p.choices = p.times.map((t, i) => Object.entries(t).reduce((best, [mode, seconds]) =>
            (!best || seconds < best.seconds
                ? { mode, seconds, travel: seconds - (mode === 'transit' ? p.waits?.[i] ?? 0 : 0) } : best), null));
        p.score = p.choices.every(Boolean) ? SCORES[metric](p.choices.map(c => c.seconds), people) : null;
    });
    return places.map((_, j) => j).filter(j => places[j].score != null).sort((a, b) => places[a].score - places[b].score);
}

// Time map: a grid over the participants and the `around` points (the best places) + GRID_MARGIN_M,
// at most GRID_MAX_CELLS cells
// of GRID_MIN_STEP_M or more. Street times exact, transit the cheap estimate (one call per cell
// for all participants), so 0 to 15 min too long. Returns { south, west, north, east, rows, cols,
// cells: [{ lat, lon, times: [{ mode: seconds }] }] }, row 0 in the north
const GRID_MARGIN_M = 1500;
const GRID_MAX_CELLS = 2500;
const GRID_MIN_STEP_M = 200;

export async function timeGrid(participants, around, slot, onProgress) {
    const mPerLat = 111320;
    const mPerLon = mPerLat * Math.cos(participants[0].lat * Math.PI / 180);
    const lats = [...participants, ...around].map(p => p.lat);
    const lons = [...participants, ...around].map(p => p.lon);
    const south = Math.min(...lats) - GRID_MARGIN_M / mPerLat;
    const north = Math.max(...lats) + GRID_MARGIN_M / mPerLat;
    const west = Math.min(...lons) - GRID_MARGIN_M / mPerLon;
    const east = Math.max(...lons) + GRID_MARGIN_M / mPerLon;
    const area = (north - south) * mPerLat * (east - west) * mPerLon;
    const step = Math.max(GRID_MIN_STEP_M, Math.sqrt(area / GRID_MAX_CELLS));
    const rows = Math.ceil((north - south) * mPerLat / step);
    const cols = Math.ceil((east - west) * mPerLon / step);
    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            cells.push({ lat: north - (r + 0.5) * (north - south) / rows, lon: west + (c + 0.5) * (east - west) / cols,
                times: participants.map(() => ({})) });
        }
    }
    onProgress(`carte des temps : ${cells.length} cases de ${Math.round(step)} m, marche, vélo, voiture…`);
    await Promise.all(participants.flatMap((p, i) => STREET_MODES.filter(m => p.modes.includes(m)).map(async mode => {
        (await motis.streetDurations(mode, p, cells, batch.signal)).forEach((d, k) => {
            if (d != null) cells[k].times[i][mode] = Math.round(d + (mode === 'car' ? CAR_PARKING_S : 0));
        });
    })));
    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    if (transit.length) {
        const arriveBy = parseParis(slot.to);
        let done = 0;
        await forEachLimited(cells.map((_, k) => k), PARALLEL, async k => {
            const estimates = await motis.transitEstimates(cells[k], transit.map(i => participants[i]), arriveBy, batch.signal);
            estimates.forEach((d, n) => { if (d != null) cells[k].times[transit[n]].transit = d; });
            if (++done % 250 === 0) onProgress(`carte des temps : bus/métro ${done}/${cells.length} cases`);
        });
    }
    return { south, west, north, east, rows, cols, cells };
}
