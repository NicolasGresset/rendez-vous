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
        .map(p => ({ ...p, times: participants.map(() => ({})), estimated: false }));

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
            if (trip) places[j].times[i].transit = trip.seconds;
            else delete places[j].times[i].transit;
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
        p.choices = p.times.map(t => Object.entries(t).reduce((best, [mode, seconds]) =>
            (!best || seconds < best.seconds ? { mode, seconds } : best), null));
        p.score = p.choices.every(Boolean) ? SCORES[metric](p.choices.map(c => c.seconds), people) : null;
    });
    return places.map((_, j) => j).filter(j => places[j].score != null).sort((a, b) => places[a].score - places[b].score);
}
