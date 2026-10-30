// motis.js - Calls to a local MOTIS server (default http://localhost:8080, MOTIS_URL to change),
// the routing engine behind Transitous, run on the Tisséo GTFS and an OpenStreetMap extract of
// the Tisséo area. Set up: docs/evaluation.md.

export const MOTIS_URL = process.env.MOTIS_URL || 'http://localhost:8080';
const STREET_MODES = { walk: 'WALK', bike: 'BIKE', car: 'CAR' };
const STREET_MAX_S = 4 * 3600;
const MATCHING_DISTANCE_M = 250;

const coords = p => `${p.lat};${p.lon}`;

async function json(res) {
    const body = await res.json();
    if (!res.ok) throw new Error(`MOTIS ${res.status}: ${body.error || JSON.stringify(body)}`);
    return body;
}

// Street durations in seconds from one point to many (null when unroutable), mode: walk, bike, car
export async function streetDurations(mode, one, many) {
    const res = await fetch(`${MOTIS_URL}/api/v1/one-to-many`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ one: coords(one), many: many.map(coords), mode: STREET_MODES[mode],
            max: STREET_MAX_S, maxMatchingDistance: MATCHING_DISTANCE_M, arriveBy: false }),
    });
    return (await json(res)).map(d => d.duration ?? null);
}

// Transit durations in seconds from many points to one, arriving by `arriveBy` (a Date): the
// shortest of the Pareto set (one entry per number of transfers), null when none
export async function transitDurationsTo(one, many, arriveBy) {
    const params = new URLSearchParams({ one: coords(one), many: many.map(coords).join(','),
        time: arriveBy.toISOString(), arriveBy: 'true' });
    const body = await json(await fetch(`${MOTIS_URL}/api/experimental/one-to-many-intermodal?${params}`));
    return body.transit_durations.map(set => (set.length ? Math.min(...set.map(e => e.duration)) : null));
}
