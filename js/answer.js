// answer.js - From the page's form to the API's question, and from its answer to what the results and the map show
// (no DOM: tested in tests/unit/answer.test.mjs)

// Names of the transit modes, as MOTIS gives them
const MODE_NAMES = {
    SUBWAY: 'métro', TRAM: 'tram', BUS: 'bus', COACH: 'car', RAIL: 'train', REGIONAL_RAIL: 'TER',
    SUBURBAN: 'train', FERRY: 'bateau', AERIAL_LIFT: 'téléphérique', FUNICULAR: 'funiculaire',
};
const STREET_LEGS = new Set(['WALK', 'BIKE', 'CAR']);

// Today's date (YYYY-MM-DD) in Toulouse, whatever the device's time zone
export const todayInToulouse = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

// The body of the API's question. participants: { lat, lon, modes, people }; slot: the meeting time "HH:MM"
export function questionOf(participants, placeType, slot, date = todayInToulouse()) {
    return {
        meetingTime: `${date}T${slot}`,
        placeType,
        participants: participants.map(({ lat, lon, modes, people }) => ({ lat, lon, modes, people })),
    };
}

// Encoded polyline (Google's format) -> [lat, lon] pairs
export function decodePolyline(points, precision) {
    const factor = 10 ** precision;
    const path = [];
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < points.length;) {
        for (const axis of [0, 1]) {
            let shift = 0;
            let value = 0;
            let byte;
            do {
                byte = points.charCodeAt(i++) - 63;
                value |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            const delta = value & 1 ? ~(value >> 1) : value >> 1;
            if (axis === 0) lat += delta; else lon += delta;
        }
        path.push([Math.round(lat / factor * 1e5) / 1e5, Math.round(lon / factor * 1e5) / 1e5]);
    }
    return path;
}

// A leg of the API -> what the page shows and draws
export function legOf(leg) {
    const common = {
        path: leg.path ? decodePolyline(leg.path.points, leg.path.precision) : [],
        from: leg.from ?? null,
        to: leg.to ?? null,
        departure: leg.departure,
        arrival: leg.arrival,
        seconds: (Date.parse(leg.arrival) - Date.parse(leg.departure)) / 1000,
    };
    if (leg.mode === 'WALK') return { kind: 'walk', ...common };
    if (STREET_LEGS.has(leg.mode)) return { kind: 'street', ...common };
    return {
        kind: 'line',
        ...common,
        mode: MODE_NAMES[leg.mode] || leg.mode.toLowerCase(),
        line: leg.line ?? null,
        headsign: leg.headsign ?? null,
        color: leg.color ?? null,
        stops: leg.stops ?? null,
    };
}

// A participant's trip of the API -> its choice, its transit journey and its path on the map (null when unreachable)
function tripOf(trip) {
    if (!trip) return { choice: null, journey: null, route: { mode: null, legs: null, error: 'injoignable' } };
    const legs = trip.legs.map(legOf);
    const known = legs.length > 0;
    return {
        choice: { mode: trip.mode, seconds: trip.seconds, travel: trip.travel },
        journey: trip.mode === 'transit' && known
            ? { seconds: trip.seconds, wait: trip.seconds - trip.travel, departure: trip.departure, arrival: trip.arrival, legs }
            : null,
        route: { mode: trip.mode, legs: known ? legs : null, error: known ? null : 'tracé indisponible' },
    };
}

// A place of the API with its trips -> a candidate. zoneInfo: its zone { index, name, kind }, or null
function candidateOf(place, score, zoneInfo) {
    const trips = place.trips.map(tripOf);
    const { id, name, category, lat, lon, street, postcode, city } = place;
    return { id, name, category, lat, lon, street, postcode, city, score, zoneInfo,
        choices: trips.map(t => t.choice), journeys: trips.map(t => t.journey), routes: trips.map(t => t.route) };
}

// The answer of POST /v1/proposals -> the result shown: the candidates (the places with their trips, then the zones'
// places without times, `pending` until chosen), the proposals (indices) and the best one
export function resultOf(answer, participants, slot) {
    const zones = answer.zones.map((zone, index) => ({ index, name: zone.name, kind: zone.kind }));
    const candidates = answer.places.map(p => candidateOf(p, p.score, p.zone != null ? zones[p.zone] : null));
    const pending = answer.zones.flatMap((zone, z) => zone.others.map(other => ({ ...other, score: null, pending: true, zoneInfo: zones[z] })));
    return {
        slot: { from: `${answer.meetingTime.slice(0, 10)} ${slot}` },
        participants,
        candidates: [...candidates, ...pending],
        proposals: answer.proposals,
        best: answer.proposals.length ? answer.proposals[0] : null,
    };
}

// The answer of POST /v1/place for a pending candidate -> the candidate with its trips; score null when someone
// cannot reach it
export function placeOf(answer, pending) {
    return { ...candidateOf(answer.place, answer.place.reachable ? answer.place.score : null, pending.zoneInfo), pending: false, computing: false };
}
