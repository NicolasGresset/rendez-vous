import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { bestJourney, forEachLimited, itineraryLegs, parseParis, transitTrip } from '../../js/transitous.js';

const FROM = '2026-11-03 19:00';
const TO = '2026-11-03 19:10';
const at = (hhmm) => parseParis(`2026-11-03 ${hhmm}`).getTime();
const trip = (departure, arrival) => ({ departure: at(departure), arrival: at(arrival) });

test('parseParis follows the time of year', () => {
    assert.equal(parseParis('2026-11-03 19:00').toISOString(), '2026-11-03T18:00:00.000Z');
    assert.equal(parseParis('2026-07-03 19:00').toISOString(), '2026-07-03T17:00:00.000Z');
});

describe('bestJourney', () => {
    test('nothing arriving by the end of the window: none', () => {
        assert.equal(bestJourney([], FROM, TO), null);
        assert.equal(bestJourney([trip('18:50', '19:11')], FROM, TO), null);
    });
    test('the last minute of the window is accepted', () => {
        assert.equal(bestJourney([trip('18:50', '19:10')], FROM, TO).seconds, 20 * 60);
    });
    test('arriving early counts the wait until the meeting time', () => {
        const found = bestJourney([trip('18:30', '18:50')], FROM, TO);
        assert.equal(found.wait, 10 * 60);
        assert.equal(found.seconds, 30 * 60);
    });
    test('the time from leaving to being there decides, not the arrival', () => {
        const early = trip('18:20', '18:50'); // 40 min with the wait
        const late = trip('18:45', '19:05'); // 20 min
        assert.equal(bestJourney([early, late], FROM, TO).journey, late);
    });
    test('at equal time, the latest departure', () => {
        const a = trip('18:40', '19:00');
        const b = trip('18:45', '19:05');
        assert.equal(bestJourney([a, b], FROM, TO).journey, b);
    });
});

test('itineraryLegs decodes paths and reads a line', () => {
    const [walk, line] = itineraryLegs({ legs: [
        { mode: 'WALK', startTime: '2026-11-03T18:00:00Z', endTime: '2026-11-03T18:05:00Z',
            legGeometry: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@', precision: 5 } },
        { mode: 'SUBWAY', startTime: '2026-11-03T18:05:00Z', endTime: '2026-11-03T18:15:00Z', routeShortName: 'A',
            routeColor: 'E3007A', intermediateStops: [{}, {}] },
    ] });
    assert.deepEqual(walk.path, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    assert.equal(walk.seconds, 300);
    assert.equal(line.mode, 'métro');
    assert.equal(line.color, '#E3007A');
    assert.equal(line.stops, 3);
});

test('itineraryLegs drops a color that is not one', () => {
    const [line] = itineraryLegs({ legs: [{ mode: 'BUS', startTime: '2026-11-03T18:00:00Z', endTime: '2026-11-03T18:05:00Z', routeColor: 'red;x' }] });
    assert.equal(line.color, null);
});

describe('transitTrip', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });
    const point = { lat: 43.6, lon: 1.44 };

    test('a journey on foot only is not a transit journey', async () => {
        globalThis.fetch = async () => new Response(JSON.stringify({ itineraries: [{
            startTime: '2026-11-03T17:55:00Z', endTime: '2026-11-03T18:00:00Z',
            legs: [{ mode: 'WALK', startTime: '2026-11-03T17:55:00Z', endTime: '2026-11-03T18:00:00Z' }],
        }] }));
        assert.equal(await transitTrip(point, point, FROM, TO), null);
    });
    test('asks for an arrival by the end of the window', async () => {
        let asked;
        globalThis.fetch = async url => { asked = new URL(url); return new Response('{"itineraries":[]}'); };
        await transitTrip(point, point, FROM, TO);
        assert.equal(asked.searchParams.get('time'), '2026-11-03T18:10:00.000Z');
        assert.equal(asked.searchParams.get('arriveBy'), 'true');
    });
    test('a rate limit and a server error are errors, not "no journey"', async () => {
        globalThis.fetch = async () => new Response('', { status: 429 });
        await assert.rejects(transitTrip(point, point, FROM, TO), /rate limit/);
        globalThis.fetch = async () => new Response('', { status: 500 });
        await assert.rejects(transitTrip(point, point, FROM, TO), /500/);
    });
    test('passes the cancellation on', async () => {
        const stop = new AbortController();
        globalThis.fetch = (url, { signal }) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
            stop.abort();
        });
        await assert.rejects(transitTrip(point, point, FROM, TO, undefined, stop.signal), { name: 'AbortError' });
    });
});

test('forEachLimited never exceeds its limit and treats every item', async () => {
    let running = 0;
    let highest = 0;
    const seen = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async item => {
        highest = Math.max(highest, ++running);
        await new Promise(resolve => setTimeout(resolve, 2));
        seen.push(item);
        running--;
    });
    assert.equal(highest, 3);
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});
