// ors.js - openrouteservice access from the browser: matrix (durations) and directions (paths)
// through the site's relay (api/ors.mjs), which holds the key. The services ignore the time of day.

import { timeoutSignal } from './transitous.js';

const TIMEOUT_MS = 15000;
const PROFILES = { walk: 'foot-walking', bike: 'cycling-regular', car: 'driving-car' };

const round = x => Math.round(x * 1e5) / 1e5;

async function orsPost(path, body, signal) {
    let res;
    try {
        res = await fetch('/api/ors', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ path, body }),
            signal:  timeoutSignal(TIMEOUT_MS, signal),
        });
    } catch (err) {
        if (err.name === 'TypeError') throw new Error('openrouteservice injoignable.', { cause: err });
        throw err;
    }
    if (res.status === 401 || res.status === 403) throw new Error('Clé openrouteservice refusée.');
    if (res.status === 429) throw new Error('Quota openrouteservice dépassé.');
    if (!res.ok) throw new Error(`openrouteservice ${path} failed: ${res.status}`);
    // Quota left on this service for the API key, as reported by the response headers
    const header = name => (res.headers.get(name) != null ? Number(res.headers.get(name)) : null);
    const quota = {
        limit:     header('x-ratelimit-limit'),
        remaining: header('x-ratelimit-remaining'),
        reset:     header('x-ratelimit-reset'), // Unix time (s)
    };
    return { data: await res.json(), quota };
}

// Durations in seconds, rows = sources, columns = destinations, null when unroutable
export async function durationMatrix(mode, sources, destinations, signal = null) {
    const { data, quota } = await orsPost(`matrix/${PROFILES[mode]}`, {
        locations:    [...sources, ...destinations].map(p => [p.lon, p.lat]),
        sources:      sources.map((_, i) => i),
        destinations: destinations.map((_, j) => sources.length + j),
        metrics:      ['duration'],
    }, signal);
    return { durations: data.durations, quota };
}

// Path from one point to another, as [lat, lon] pairs
export async function routePath(mode, from, to, signal = null) {
    const { data, quota } = await orsPost(`directions/${PROFILES[mode]}/geojson`, {
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
    }, signal);
    const path = data.features[0].geometry.coordinates.map(([lon, lat]) => [round(lat), round(lon)]);
    return { path, quota };
}
