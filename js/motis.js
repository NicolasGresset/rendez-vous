// motis.js - The debug view's local MOTIS (the engine behind Transitous, run on the Tisséo GTFS
// and an OpenStreetMap extract, docs/evaluation.md), reached through the dev server's /motis/
// relay (scripts/dev-server.js). Only on the developer's machine: elsewhere available() is false
// without any call, and the engine is not offered. Street times (walk, bike, car), their paths, transit journeys (as transitous.js asks
// Transitous), a cheap transit estimate, and the network's lines for the map.

import { itineraryLegs, transitTrip } from './transitous.js';

const BASE = '/motis';
const STREET_MODES = { walk: 'WALK', bike: 'BIKE', car: 'CAR' };
const STREET_MAX_S = 4 * 3600;
const MATCHING_DISTANCE_M = 250;
const coords = p => `${p.lat};${p.lon}`;

async function json(res) {
    const body = await res.json();
    if (!res.ok) throw new Error(`MOTIS ${res.status}: ${body.error || 'error'}`);
    return body;
}

export async function available() {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return false;
    try {
        return (await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
        return false;
    }
}

// Street durations in seconds from one point to many, null when unroutable
export async function streetDurations(mode, one, many) {
    const res = await fetch(`${BASE}/api/v1/one-to-many`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ one: coords(one), many: many.map(coords), mode: STREET_MODES[mode],
            max: STREET_MAX_S, maxMatchingDistance: MATCHING_DISTANCE_M, arriveBy: false }),
    });
    return (await json(res)).map(d => d.duration ?? null);
}

// Same contract as ors.js durationMatrix: rows = sources, columns = destinations
export async function durationMatrix(mode, sources, destinations) {
    return { durations: await Promise.all(sources.map(s => streetDurations(mode, s, destinations))) };
}

// Path by walk, bike or car, as [lat, lon] pairs (ors.js routePath contract)
export async function routePath(mode, from, to) {
    const params = new URLSearchParams({ fromPlace: `${from.lat},${from.lon}`, toPlace: `${to.lat},${to.lon}`,
        directModes: STREET_MODES[mode], transitModes: '', maxDirectTime: String(STREET_MAX_S) });
    const body = await json(await fetch(`${BASE}/api/v6/plan?${params}`));
    const direct = body.direct?.[0];
    if (!direct) throw new Error('no street path');
    return { path: itineraryLegs(direct).flatMap(leg => leg.path) };
}

// Transit trip as transitous.js computes it, on the local server
export const trip = (from, to, arriveFrom, arriveTo) => transitTrip(from, to, arriveFrom, arriveTo, `${BASE}/api/v6/plan`);

// Cheap transit estimate from many points to one, arriving by `arriveBy` (a Date): MOTIS counts
// the time up to arriveBy, so 0 to 15 min more than the trip above (checked 2026-10-30: median
// +8 min); null when none
export async function transitEstimates(one, many, arriveBy) {
    const params = new URLSearchParams({ one: coords(one), many: many.map(coords).join(','),
        time: arriveBy.toISOString(), arriveBy: 'true' });
    const body = await json(await fetch(`${BASE}/api/experimental/one-to-many-intermodal?${params}`));
    return body.transit_durations.map(set => (set.length ? Math.min(...set.map(e => e.duration)) : null));
}

// The network's lines in a box: [{ mode, color, path: [[lat, lon]…], names }]
export async function networkLines(south, west, north, east) {
    const params = new URLSearchParams({ zoom: '14', min: `${south},${east}`, max: `${north},${west}` });
    const body = await json(await fetch(`${BASE}/api/experimental/map/routes?${params}`));
    return body.polylines.map(p => {
        const routes = p.routeIndexes.map(i => body.routes[i]);
        return {
            mode: routes[0]?.mode,
            color: `#${p.colors[0] || '7A90AA'}`,
            path: decode(p.polyline.points, p.polyline.precision),
            names: [...new Set(routes.flatMap(r => r.transitRoutes.map(t => t.shortName)))],
        };
    });
}

// Encoded polyline -> [lat, lon] pairs, through itineraryLegs' decoding
const decode = (points, precision) => itineraryLegs({ legs: [{ mode: 'WALK', legGeometry: { points, precision } }] })[0].path;
