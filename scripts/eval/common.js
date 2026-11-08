// common.js - What the evaluation's scripts share since the page no longer computes anything: the place types, the
// late tolerance, Toulouse time, parallel calls, and the transit trip as the service computes it
// (middleware/motis.go TransitTrip).

import { MOTIS_URL } from './motis.js';

// Categories of candidate places per place type (middleware/data.go placeCategories)
export const CATEGORIES = { station: ['metro', 'bus'], bar: ['amenity=bar', 'amenity=pub', 'amenity=biergarten'], cafe: ['amenity=cafe'], restaurant: ['amenity=restaurant'] };
export const LATE_TOLERANCE_MIN = 10; // middleware/zones.go lateTolerance

// UTC offset of Europe/Paris at a given date, e.g. "+01:00"
function parisOffset(date) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
        .formatToParts(new Date(`${date}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value;
    return name === 'GMT' ? '+00:00' : name.slice(3);
}

// "YYYY-MM-DD HH:MM" in Toulouse -> Date
export const parseParis = local => {
    const [date, time] = local.split(' ');
    return new Date(`${date}T${time}:00${parisOffset(date)}`);
};

// Run fn on every item, at most `parallel` at a time
export async function forEachLimited(items, parallel, fn) {
    const queue = [...items];
    const worker = async () => {
        while (queue.length) await fn(queue.shift());
    };
    await Promise.all(Array.from({ length: parallel }, worker));
}

// The journey with a transit line taking the least time from leaving to being there for the slot (an early arrival
// counting the wait); at equal time, the latest departure. { seconds, wait } or null
export async function transitTrip(from, to, arriveFrom, arriveTo) {
    const params = new URLSearchParams({ fromPlace: `${from.lat},${from.lon}`, toPlace: `${to.lat},${to.lon}`,
        time: parseParis(arriveTo).toISOString(), arriveBy: 'true', maxItineraries: 5, detailedTransfers: false });
    const res = await fetch(`${MOTIS_URL}/api/v6/plan?${params}`);
    if (!res.ok) throw new Error(`MOTIS plan failed: ${res.status}`);
    const slotStart = parseParis(arriveFrom).getTime();
    const slotEnd = parseParis(arriveTo).getTime();
    const journeys = ((await res.json()).itineraries || [])
        .filter(it => it.legs.some(leg => leg.mode !== 'WALK'))
        .map(it => ({ departure: Date.parse(it.startTime), arrival: Date.parse(it.endTime) }))
        .filter(j => j.arrival <= slotEnd);
    if (!journeys.length) return null;
    const cost = j => Math.max(j.arrival, slotStart) - j.departure;
    const best = journeys.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && b.departure > a.departure) ? b : a));
    return { seconds: cost(best) / 1000, wait: Math.max(0, slotStart - best.arrival) / 1000 };
}
