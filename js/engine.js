// engine.js - Meeting point computation, in the browser: candidates around the participants'
// barycenter (weighted by the people leaving from each starting point), each participant's travel
// time per mode to be there today at the meeting time, at most LATE_TOLERANCE_MIN late (arriving
// early counts as waiting), and the candidates ranked by a score
// of each participant's fastest time (see SCORES).
//
// Progress is reported through emit(event), with event.type:
//   start -> candidates -> matrix (one per mode) -> transit (progress) -> result
//   -> route (one per participant, path to the chosen place with the retained mode) -> done
// Errors are thrown, an AbortError when input.signal is cancelled: nothing is emitted after it.

import { durationMatrix, routePath } from './ors.js';
import { transitTrip, forEachLimited } from './transitous.js';
import { tisseoTrip, TisseoKeyError } from './tisseo.js';
import * as motis from './motis.js';

const ORS_MODES = ['walk', 'bike', 'car'];
const RETRY_DELAY_MS = 2000; // a transit journey failing for a technical reason is tried once more
// Transit engines: journey function (same contract, counting its calls in calls[name]) and
// journeys computed in parallel. Transitous slows down beyond 3; Tisséo answered 6 in parallel
// without slowing down (2026-10-28)
const TRANSIT_ENGINES = {
    transitous: { trip: (keys, onCall, from, to, arriveFrom, arriveTo, signal) => (onCall(), transitTrip(from, to, arriveFrom, arriveTo, undefined, signal)), parallel: 3 },
    tisseo:     { trip: (keys, onCall, ...args) => tisseoTrip(keys.tisseo, onCall, ...args), parallel: 6 },
    // Debug view only (dev server and local MOTIS, motis.js): walk, bike and car times and paths
    // come from it too, instead of openrouteservice
    motis:      { trip: (keys, onCall, ...args) => (onCall(), motis.trip(...args)), parallel: 8 },
};
const ENGINE_NAMES = { transitous: 'Transitous', tisseo: 'Tisséo', motis: 'MOTIS local' };
// Arrival window [meeting time, + this]: a bus arriving at 19:01 would otherwise force the one
// arriving at 18:46. Fixed: 5 to 15 min change little (docs/evaluation.md § Arrival rules)
export const LATE_TOLERANCE_MIN = 10;
const CAR_PARKING_S = 5 * 60;      // fixed time to park, added to every car trip
const RADIUS_START_M = 1000;
const RADIUS_STEP_M = 500;
const RADIUS_MAX_M = 5000;
// Candidates at least this far apart: close ones bring little information, and the 3 proposals
// taken from them are then distinct places to choose from (docs/evaluation.md § Diversity)
const CANDIDATE_SPACING_M = 700;
const MAX_CANDIDATES = 8; // default and maximum: each candidate costs one transit journey per participant

// Categories the user picks from, and the place categories of data/pois-toulouse.json they cover:
// only these places can be candidates, the others are for the address search
export const CATEGORIES = { station: ['metro', 'bus'], bar: ['amenity=bar', 'amenity=pub', 'amenity=biergarten'], cafe: ['amenity=cafe'], restaurant: ['amenity=restaurant'] };
const CANDIDATE_CATEGORIES = new Set(Object.values(CATEGORIES).flat());
// Maximum candidates per category: the total split evenly in the order the categories come, the
// first ones getting the rest (8 over stations, bars, restaurants: 3, 3, 2). Fewer if fewer nearby
function quotasFor(categories, total) {
    return Object.fromEntries(categories.map((category, i) =>
        [category, Math.floor(total / categories.length) + (i < total % categories.length ? 1 : 0)]));
}

// Every place (OSM places, Tisséo GTFS stops) and the French label of each category, a static
// file served with the site
export async function loadData() {
    const res = await fetch('data/pois-toulouse.json');
    if (!res.ok) throw new Error(`data/pois-toulouse.json failed: ${res.status}`);
    return res.json();
}

// "YYYY-MM-DD HH:MM" + minutes, computed on the digits (read as UTC: no time zone shift)
const addMinutes = (local, minutes) => new Date(Date.parse(`${local.replace(' ', 'T')}:00Z`) + minutes * 60000)
    .toISOString().slice(0, 16).replace('T', ' ');

// Today's date (YYYY-MM-DD) in Toulouse, whatever the device time zone
const todayInToulouse = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

// Mean of latitudes and longitudes, each starting point weighted by the people leaving from it
function barycenter(points) {
    const people = points.reduce((s, p) => s + p.people, 0);
    return {
        lat: points.reduce((s, p) => s + p.people * p.lat, 0) / people,
        lon: points.reduce((s, p) => s + p.people * p.lon, 0) / people,
    };
}

// Great-circle distance in meters
export function haversine(a, b) {
    const rad = deg => deg * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Closest places of the picked categories within radius meters, within each category's quota and
// CANDIDATE_SPACING_M apart, across categories too
function candidatesWithin(places, center, categories, total, radius) {
    const seen = new Set();
    const nearby = places
        .map(p => ({ ...p, distance: Math.round(haversine(center, p)) }))
        .filter(p => p.distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        // A place mapped twice under the same name counts once
        .filter(c => !seen.has(`${c.category}:${c.name}`) && seen.add(`${c.category}:${c.name}`));
    const chosen = [];
    // Adds up to count places of pool, closest first, and returns how many
    const pick = (pool, count) => {
        let added = 0;
        for (const p of pool) {
            if (added === count) break;
            if (chosen.every(c => c !== p && haversine(c, p) >= CANDIDATE_SPACING_M)) {
                chosen.push(p);
                added++;
            }
        }
        return added;
    };
    const quotas = quotasFor(categories, total);
    categories.forEach(category => {
        const pool = nearby.filter(p => CATEGORIES[category].includes(p.category));
        let quota = quotas[category];
        // Half of the stations (rounded up) go to the metro first, so that the numerous
        // bus stops do not crowd it out; the closest remaining stops fill the rest
        if (category === 'station') quota -= pick(pool.filter(p => p.category === 'metro'), Math.ceil(quota / 2));
        pick(pool, quota);
    });
    return chosen.sort((a, b) => a.distance - b.distance);
}

// The search radius grows by RADIUS_STEP_M until all the candidates are found, up to
// RADIUS_MAX_M (local data only: no API call, whatever the radius)
function findCandidates(places, center, categories, total) {
    const pool = places.filter(p => CANDIDATE_CATEGORIES.has(p.category));
    let radius = RADIUS_START_M;
    let candidates = candidatesWithin(pool, center, categories, total, radius);
    while (candidates.length < total && radius < RADIUS_MAX_M) {
        radius += RADIUS_STEP_M;
        candidates = candidatesWithin(pool, center, categories, total, radius);
    }
    return { candidates, radius };
}

// Fastest available mode of one participant to one candidate, null if none. seconds: the time that
// is scored, with the wait until the meeting time when arriving early; travel: the door-to-door
// time that is shown, without it
function fastest(modeTimes) {
    return Object.entries(modeTimes)
        .filter(([, t]) => t.seconds != null)
        .reduce((best, [mode, t]) => (!best || t.seconds < best.seconds
            ? { mode, seconds: t.seconds, travel: t.seconds - (t.trip?.wait ?? 0) } : best), null);
}

// Scores of a candidate from each participant's fastest time in seconds and the people leaving
// from their starting point (lower is better); every person counts, so a participant of 3 people
// counts 3 times. mean ("égalitaire"): the mean time per person, every minute counting the same
// whoever spends it; half ("équitable", the default): the mean plus half the excess of the longest
// trip over it, (1 - β) mean + β max with β = 1/2 (Ogryczak), so that the one coming from far is
// not penalized much (the longest trip does not depend on the people). Both never improve when a
// trip gets longer, unlike the former "moyenne + écart" (dropped 2026-10-30: (10, 30) min scored
// 40 and (20, 30) 35, although nobody gains; docs/evaluation.md)
const totalTime = (seconds, people) => seconds.reduce((s, x, i) => s + people[i] * x, 0);
const meanTime = (seconds, people) => totalTime(seconds, people) / people.reduce((s, n) => s + n, 0);
export const SCORES = {
    mean: meanTime,
    half: (seconds, people) => (meanTime(seconds, people) + Math.max(...seconds)) / 2,
};
const DEFAULT_METRIC = 'half';

// Sets each evaluated candidate's score for the metric (null when someone cannot reach it) and
// returns the indices of the reachable ones, best first. A candidate is incomplete when a transit
// journey to it failed: its score may be too high (transit unknown, not impossible), so it comes
// after the complete ones, unless none is reachable. Equal scores: the lower total first.
// Called again when the metric changes: the times are kept, no new call is made.
// people: the people of each participant
export function rankCandidates(candidates, metric, people) {
    candidates.forEach(c => {
        c.score = c.choices.every(Boolean) ? SCORES[metric](c.choices.map(x => x.seconds), people) : null;
    });
    const feasible = candidates.map((c, j) => j).filter(j => candidates[j].score != null);
    const complete = feasible.filter(j => !candidates[j].incomplete);
    return (complete.length ? complete : feasible)
        .sort((a, b) => candidates[a].score - candidates[b].score || candidates[a].total - candidates[b].total);
}

// What every result carries: today's date, the arrival window, the barycenter, the participants
export function computationBase(participants, slot) {
    const date = todayInToulouse();
    const arriveFrom = `${date} ${slot}`;
    return { date, slot: { from: arriveFrom, to: addMinutes(arriveFrom, LATE_TOLERANCE_MIN) }, center: barycenter(participants), participants };
}

// participants: [{ lat, lon, modes, people }], slot: the meeting time "HH:MM",
// categories: keys of CATEGORIES (1 to 4), transitEngine: key of TRANSIT_ENGINES,
// maxCandidates: places evaluated, at most MAX_CANDIDATES, metric: key of SCORES,
// signal: to cancel the computation and its calls (optional),
// keys: { ors, tisseo }, data: from loadData(),
// calls: external API call counters, updated as calls are made
export async function evaluate({ participants, slot, categories,
    transitEngine = 'transitous', maxCandidates = MAX_CANDIDATES,
    metric = DEFAULT_METRIC, signal = null },
    keys, data, calls, emit) {
    const base = computationBase(participants, slot);
    const { center, slot: { from: arriveFrom, to: arriveTo } } = base;
    emit({ type: 'start', ...base });

    const total = Math.max(1, Math.min(MAX_CANDIDATES, maxCandidates));
    const { candidates, radius } = findCandidates(data.places, center, categories, total);
    emit({ type: 'candidates', candidates, radius, sources: data.sources });
    if (!candidates.length) {
        emit({ type: 'result', ...base, candidates, ranking: [], best: null, metric });
        return emit({ type: 'done' });
    }

    // times[i][j][mode] = { seconds } or { error } for participant i and candidate j
    const times = participants.map(() => candidates.map(() => ({})));

    // One openrouteservice matrix per mode (local MOTIS street times with the debug view's engine)
    const durations = {};
    const localStreets = transitEngine === 'motis';
    await Promise.all(ORS_MODES.map(async mode => {
        const indices = participants.map((_, i) => i).filter(i => participants[i].modes.includes(mode));
        if (!indices.length) return;
        const sources = indices.map(i => participants[i]);
        let matrix;
        if (localStreets) {
            calls.motis++;
            matrix = await motis.durationMatrix(mode, sources, candidates, signal);
        } else {
            calls.orsMatrix++;
            matrix = await durationMatrix(keys.ors, mode, sources, candidates, signal);
        }
        durations[mode] = new Map(indices.map((i, k) => [i, matrix.durations[k]]));
        emit({ type: 'matrix', mode, sources: indices.length, destinations: candidates.length,
            ...(matrix.quota && { orsQuota: { service: 'matrix', ...matrix.quota } }) });
    }));

    const transitPairs = [];
    participants.forEach((p, i) => candidates.forEach((c, j) => {
        for (const mode of ORS_MODES.filter(m => p.modes.includes(m))) {
            const seconds = durations[mode].get(i)[j];
            times[i][j][mode] = seconds == null
                ? { error: 'itinéraire introuvable' }
                : { seconds: Math.round(seconds + (mode === 'car' ? CAR_PARKING_S : 0)) };
        }
        if (!p.modes.includes('transit')) return;
        transitPairs.push([i, j]);
    }));

    // Every candidate keeps its journeys (legs, lines, times): choosing another place needs no new call
    const engine = TRANSIT_ENGINES[transitEngine];
    // A technical failure (timeout, rate limit, server error) is tried once more after a pause;
    // if it fails again, the journey is marked failed: its candidate is incomplete (see below)
    const engineName = ENGINE_NAMES[transitEngine];
    const onCall = () => { calls[transitEngine]++; };
    const trip = (i, j) => engine.trip(keys, onCall, participants[i], candidates[j], arriveFrom, arriveTo, signal);
    const tripWithRetry = async (i, j) => {
        try {
            return await trip(i, j);
        } catch (err) {
            if (err instanceof TisseoKeyError || err.name === 'AbortError') throw err;
            console.warn(`${engineName} failed, trying again: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        signal?.throwIfAborted();
        try {
            return await trip(i, j);
        } catch (err) {
            // Tisséo unreachable twice in a row: most likely a refused key
            if (err.unreachable) throw new TisseoKeyError(err.message);
            throw err;
        }
    };
    let done = 0;
    let errors = 0;
    const progress = () => emit({ type: 'transit', engine: transitEngine, done, errors, total: transitPairs.length });
    progress();
    await forEachLimited(transitPairs, engine.parallel, async ([i, j]) => {
        try {
            const trip = await tripWithRetry(i, j);
            times[i][j].transit = trip == null
                ? { error: 'aucun trajet n\'arrive à temps' }
                : { seconds: trip.seconds, trip };
        } catch (err) {
            if (err instanceof TisseoKeyError || err.name === 'AbortError') throw err;
            console.error(err);
            errors++;
            times[i][j].transit = { error: `${engineName} indisponible (2 essais)`, failed: true };
        }
        done++;
        progress();
    });
    signal?.throwIfAborted();

    // Each participant's fastest time; the total breaks ties
    const people = participants.map(p => p.people);
    const evaluated = candidates.map((c, j) => {
        const choices = participants.map((_, i) => fastest(times[i][j]));
        const seconds = choices.every(Boolean) ? choices.map(x => x.seconds) : null;
        const incomplete = participants.some((_, i) => times[i][j].transit?.failed);
        return { ...c, incomplete, choices, times: participants.map((_, i) => times[i][j]),
            total: seconds && totalTime(seconds, people) };
    });
    const ranking = rankCandidates(evaluated, metric, people);
    const best = ranking.length ? ranking[0] : null;

    emit({ type: 'result', ...base, candidates: evaluated, ranking, best, metric });
    if (best != null) await placeRoutes(participants, evaluated[best], keys, calls, emit, transitEngine, signal);
    emit({ type: 'done' });
}

// Paths to a place with each participant's retained mode, emitted as route events: the legs of
// the Transitous journey already fetched, or one openrouteservice directions call per participant
// (made only for the places actually displayed; local MOTIS paths with the debug view's engine).
// signal: to cancel the calls (an AbortError is then thrown)
export async function placeRoutes(participants, place, keys, calls, emit, transitEngine = 'transitous', signal = null) {
    await Promise.all(participants.map(async (p, i) => {
        const choice = place.choices[i];
        if (!choice) return emit({ type: 'route', place: place.id, participant: i, legs: null, error: 'injoignable' });
        const { mode } = choice;
        if (mode === 'transit') {
            const legs = place.times[i].transit.trip?.legs;
            return emit({ type: 'route', place: place.id, participant: i, mode, legs: legs || null, error: legs ? null : 'tracé indisponible' });
        }
        try {
            let route;
            if (transitEngine === 'motis') {
                calls.motis++;
                route = await motis.routePath(mode, p, place, signal);
            } else {
                calls.orsDirections++;
                route = await routePath(keys.ors, mode, p, place, signal);
            }
            emit({ type: 'route', place: place.id, participant: i, mode, legs: [{ kind: mode, path: route.path }],
                ...(route.quota && { orsQuota: { service: 'directions', ...route.quota } }) });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            console.error(err);
            emit({ type: 'route', place: place.id, participant: i, mode, legs: null, error: 'tracé indisponible' });
        }
    }));
}
