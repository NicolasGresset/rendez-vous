// debug-motis.js - Debug view with the local MOTIS (motis.js): every candidate place of the picked
// categories, not only those around the barycenter, with each participant's times, to compare the
// tool's proposals with the best places of the whole file (as scripts/eval does offline).
// Street times are exact (one call per participant and mode). Transit: exact for every place up
// to EXACT_ALL_MAX places; beyond, a cheap estimate for every place (one call per place for all
// participants, 0 to 15 min too long) and exact times for the EXACT_SHORTLIST best of each score.

import * as motis from './motis.js';
import { CATEGORIES, CANDIDATE_SPACING_M, SCORES, haversine } from './engine.js';
import { forEachLimited, parseParis } from './transitous.js';
import { PROPOSALS } from './results.js';

const EXACT_ALL_MAX = 600;
const EXACT_SHORTLIST = 100;
const PARALLEL = 8;
const CAR_PARKING_S = 5 * 60; // as engine.js
const STREET_MODES = ['walk', 'bike', 'car'];
const ZONE_RADIUS_M = 3000;      // zones scored around the barycenter, the radius growing until
const ZONE_RADIUS_STEP_M = 500;  // MIN_ZONES are found (docs/evaluation.md: 2 km loses, 4 km brings little)
const ZONE_RADIUS_MAX_M = 30000;
const MIN_ZONES = 8;

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
            const estimates = await motis.transitEstimates(places[j], transit.map(i => participants[i]), arriveBy);
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
const toScore = (p, participants) => ({ ...p, times: participants.map(() => ({})), waits: participants.map(() => 0), estimated: false });

// Street times of every participant to every place
async function streetTimes(participants, places) {
    await Promise.all(participants.flatMap((p, i) => STREET_MODES.filter(m => p.modes.includes(m)).map(async mode => {
        const durations = await motis.streetDurations(mode, p, places);
        durations.forEach((d, j) => {
            if (d != null) places[j].times[i][mode] = Math.round(d + (mode === 'car' ? CAR_PARKING_S : 0));
        });
    })));
}

// Exact transit journeys to the places of these indices; returns how many were asked
async function exactTransit(participants, places, indices, slot, onProgress) {
    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    const pairs = indices.flatMap(j => transit.map(i => [i, j]));
    let done = 0;
    await forEachLimited(pairs, PARALLEL, async ([i, j]) => {
        const trip = await motis.trip(participants[i], places[j], slot.from, slot.to);
        if (trip) {
            places[j].times[i].transit = trip.seconds;
            places[j].waits[i] = trip.wait;
        } else {
            delete places[j].times[i].transit;
        }
        if (++done % 100 === 0) onProgress(`trajets bus/métro exacts : ${done}/${pairs.length}`);
    });
    indices.forEach(j => { places[j].estimated = false; });
    return pairs.length;
}

// The method planned with the zones of the data file (scripts/build-zones.js): each zone's
// representative scored within ZONE_RADIUS_M of the barycenter, the PROPOSALS best zones at least
// CANDIDATE_SPACING_M apart, then every place of these zones scored; a zone's best place makes its rank.
// Stations have no zones. No richer zone is favoured. Returns null without bars nor restaurants, or
// { zones: [{ kind, name, lat, lon, places: best first }], radius, zonesScored, journeys, seconds }
export async function scoreZones(participants, categories, center, slot, data, metric, onProgress) {
    const kinds = categories.filter(c => c !== 'station');
    if (!kinds.length) return null;
    const started = performance.now();
    const people = participants.map(p => p.people);
    const members = data.zones.map(() => []);
    data.places.forEach(p => { if (p.zone != null) members[p.zone].push(p); });
    const zones = data.zones.map((zone, index) => ({ ...zone, members: members[index] }))
        .filter(zone => kinds.includes(zone.kind));

    let radius = ZONE_RADIUS_M;
    let pool = zones.filter(zone => haversine(center, zone) <= radius);
    while (pool.length < MIN_ZONES && radius < ZONE_RADIUS_MAX_M) {
        radius += ZONE_RADIUS_STEP_M;
        pool = zones.filter(zone => haversine(center, zone) <= radius);
    }

    // A zone's position is its representative's
    const closestMember = zone => zone.members.reduce((best, p) =>
        (haversine(zone, p) < haversine(zone, best) ? p : best));
    const reps = pool.map(zone => toScore(closestMember(zone), participants));
    onProgress(`zones : ${pool.length} représentants à moins de ${radius / 1000} km…`);
    await streetTimes(participants, reps);
    let journeys = await exactTransit(participants, reps, reps.map((_, j) => j), slot, onProgress);
    const kept = [];
    for (const j of scorePlaces(reps, metric, people)) {
        if (kept.length < PROPOSALS && kept.every(k => haversine(pool[k], pool[j]) >= CANDIDATE_SPACING_M)) kept.push(j);
    }

    // Second round: the other places of the zones kept, the representatives' times being known
    const others = kept.flatMap(k => pool[k].members.filter(p => p.id !== reps[k].id).map(p => toScore(p, participants)));
    onProgress(`zones : ${others.length} autres lieux des ${kept.length} meilleures…`);
    if (others.length) {
        await streetTimes(participants, others);
        journeys += await exactTransit(participants, others, others.map((_, j) => j), slot, onProgress);
    }
    const scored = [...kept.map(k => reps[k]), ...others];
    const ranking = scorePlaces(scored, metric, people);
    const shown = kept.map(k => ({
        ...pool[k],
        places: ranking.map(j => scored[j]).filter(p => p.zone === reps[k].zone),
    })).sort((a, b) => a.places[0].score - b.places[0].score);
    return { zones: shown, radius, zonesScored: pool.length, journeys, seconds: (performance.now() - started) / 1000 };
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
        (await motis.streetDurations(mode, p, cells)).forEach((d, k) => {
            if (d != null) cells[k].times[i][mode] = Math.round(d + (mode === 'car' ? CAR_PARKING_S : 0));
        });
    })));
    const transit = participants.map((p, i) => i).filter(i => participants[i].modes.includes('transit'));
    if (transit.length) {
        const arriveBy = parseParis(slot.to);
        let done = 0;
        await forEachLimited(cells.map((_, k) => k), PARALLEL, async k => {
            const estimates = await motis.transitEstimates(cells[k], transit.map(i => participants[i]), arriveBy);
            estimates.forEach((d, n) => { if (d != null) cells[k].times[transit[n]].transit = d; });
            if (++done % 250 === 0) onProgress(`carte des temps : bus/métro ${done}/${cells.length} cases`);
        });
    }
    return { south, west, north, east, rows, cols, cells };
}
