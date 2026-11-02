// demo-motis.js - Demonstrator with the local MOTIS (motis.js): every candidate place of the picked
// categories, not only those around the barycenter, with each participant's times, to compare the
// tool's proposals with the best places of the whole file (as scripts/eval does offline).
// Street times are exact (one call per participant and mode). Transit: exact for every place up
// to EXACT_ALL_MAX places; beyond, a cheap estimate for every place (one call per place for all
// participants, 0 to 15 min too long) and exact times for the EXACT_SHORTLIST best of each score.

import * as motis from './motis.js';
import { CATEGORIES, SCORES } from './engine.js';
import { forEachLimited, parseParis } from './transitous.js';

const EXACT_ALL_MAX = 400;
const EXACT_SHORTLIST = 100;
const PARALLEL = 8;
const CAR_PARKING_S = 5 * 60; // as engine.js
const STREET_MODES = ['walk', 'bike', 'car'];

// participants: [{ lat, lon, modes, people }], slot: { from, to } ("YYYY-MM-DD HH:MM", as in the
// result event); onProgress(text). Returns { places: [{ ...place, times: [{ mode: seconds }],
// estimated: transit times not all exact }], estimated (count) }
export async function enumeratePlaces(participants, categories, slot, data, onProgress) {
    const allowed = new Set(categories.flatMap(c => CATEGORIES[c]));
    const places = data.places.filter(p => allowed.has(p.category))
        .map(p => ({ ...p, times: participants.map(() => ({})), waits: participants.map(() => 0), estimated: false }));

    onProgress(`temps marche, vélo, voiture vers ${places.length} lieux…`);
    await Promise.all(participants.flatMap((p, i) => STREET_MODES.filter(m => p.modes.includes(m)).map(async mode => {
        const durations = await motis.streetDurations(mode, p, places);
        durations.forEach((d, j) => {
            if (d != null) places[j].times[i][mode] = Math.round(d + (mode === 'car' ? CAR_PARKING_S : 0));
        });
    })));

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
    if (transit.length) {
        const pairs = exactPlaces.flatMap(j => transit.map(i => [i, j]));
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
        exactPlaces.forEach(j => { places[j].estimated = false; });
    }
    return { places, estimated: places.filter(p => p.estimated).length };
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
