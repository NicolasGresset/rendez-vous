// The computation without a browser: scores, ranking, and evaluate() with fetch replaced.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { evaluate, haversine, rankCandidates, SCORES } from '../../js/engine.js';

const MIN = 60;
const candidate = (seconds, extra = {}) => ({
    choices: seconds.map(s => (s == null ? null : { mode: 'walk', seconds: s, travel: s })),
    total: seconds.every(s => s != null) ? seconds.reduce((a, b) => a + b, 0) : null,
    ...extra,
});

describe('scores', () => {
    test('égalitaire is the mean per person', () => {
        assert.equal(SCORES.mean([10, 30], [1, 1]), 20);
        assert.equal(SCORES.mean([10, 30], [3, 1]), 15);
    });
    test('équitable is the mean plus half of what the longest trip has more', () => {
        assert.equal(SCORES.half([10, 30], [1, 1]), 25);
        assert.equal(SCORES.half([20, 20], [1, 1]), 20);
    });
    test('a longer trip for someone never improves a score', () => {
        // The reason "moyenne + écart" was dropped: (10, 30) scored worse than (20, 30)
        for (const score of Object.values(SCORES)) {
            assert.ok(score([20, 30], [1, 1]) >= score([10, 30], [1, 1]));
        }
    });
});

describe('rankCandidates', () => {
    const people = [1, 1];
    test('best first, by the chosen score', () => {
        const places = [candidate([10, 30]), candidate([19, 20])];
        assert.deepEqual(rankCandidates(places, 'half', people), [1, 0]);
        assert.deepEqual(rankCandidates([candidate([10, 20]), candidate([16, 16])], 'mean', people), [0, 1]);
    });
    test('a place someone cannot reach has no score and is left out', () => {
        const places = [candidate([10, null]), candidate([40, 40])];
        assert.deepEqual(rankCandidates(places, 'half', people), [1]);
        assert.equal(places[0].score, null);
    });
    test('a place with a failed journey only comes when nothing complete is reachable', () => {
        const incomplete = candidate([5, 5], { incomplete: true });
        assert.deepEqual(rankCandidates([incomplete, candidate([40, 40])], 'half', people), [1]);
        assert.deepEqual(rankCandidates([incomplete, candidate([40, null])], 'half', people), [0]);
    });
    test('equal scores: the lower total first', () => {
        const places = [candidate([10, 10], { total: 30 }), candidate([10, 10], { total: 20 })];
        assert.deepEqual(rankCandidates(places, 'half', people), [1, 0]);
    });
});

test('haversine: a degree of latitude is about 111 km', () => {
    assert.ok(Math.abs(haversine({ lat: 43, lon: 1 }, { lat: 44, lon: 1 }) - 111195) < 10);
});

describe('evaluate', () => {
    const realFetch = globalThis.fetch;
    const realWarn = console.warn;
    const realError = console.error;
    afterEach(() => {
        globalThis.fetch = realFetch;
        console.warn = realWarn;
        console.error = realError;
    });
    beforeEach(() => {
        console.warn = () => {};
        console.error = () => {};
    });

    // Bars north of the participants, 1.1 km apart
    const places = Array.from({ length: 12 }, (_, i) => ({ id: `node/${i}`, name: `Bar ${i}`, category: 'amenity=bar',
        lat: 43.6 + i * 0.01, lon: 1.44 }));
    const data = { places, sources: {} };
    const participants = [{ lat: 43.6, lon: 1.44, modes: ['transit'], people: 1 }, { lat: 43.61, lon: 1.44, modes: ['transit'], people: 1 }];
    const barOf = url => places.findIndex(p => new URL(url).searchParams.get('toPlace') === `${p.lat},${p.lon}`);

    // An answer of Transitous: one bus arriving just before the asked time, lasting minutes(url) min
    const journey = minutes => async url => {
        const end = Date.parse(new URL(url).searchParams.get('time')) - 5 * MIN * 1000;
        const start = end - minutes(url) * MIN * 1000;
        const iso = ms => new Date(ms).toISOString();
        return new Response(JSON.stringify({ itineraries: [{ startTime: iso(start), endTime: iso(end),
            legs: [{ mode: 'BUS', startTime: iso(start), endTime: iso(end), routeShortName: '14' }] }] }));
    };
    const run = async (input = {}) => {
        const events = [];
        const calls = { orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0, motis: 0 };
        await evaluate({ participants, slot: '19:00', categories: ['bar'], ...input }, {}, data, calls, e => events.push(e));
        return { events, calls, result: events.find(e => e.type === 'result') };
    };

    test('one journey per participant and candidate, the shortest place first', async () => {
        globalThis.fetch = journey(url => 10 + barOf(url));
        const { result, calls, events } = await run();
        assert.equal(calls.transitous, participants.length * result.candidates.length);
        assert.equal(result.candidates[result.best].name, 'Bar 0');
        assert.equal(events.at(-1).type, 'done');
    });

    test('at most 8 candidates, at least 700 m apart', async () => {
        globalThis.fetch = journey(() => 10);
        // Bars every 110 m: most of them must be left out
        const close = Array.from({ length: 40 }, (_, i) => ({ id: `node/${i}`, name: `Bar ${i}`, category: 'amenity=bar', lat: 43.6 + i * 0.001, lon: 1.44 }));
        const events = [];
        await evaluate({ participants, slot: '19:00', categories: ['bar'] }, {}, { places: close, sources: {} },
            { transitous: 0 }, e => events.push(e));
        const { candidates } = events.find(e => e.type === 'result');
        assert.ok(candidates.length <= 8 && candidates.length > 1);
        candidates.forEach((a, i) => candidates.slice(i + 1).forEach(b => assert.ok(haversine(a, b) >= 700)));
    });

    test('no journey arriving in time: the place is unreachable, not chosen', async () => {
        globalThis.fetch = url => (barOf(url) === 0 ? Promise.resolve(new Response('{"itineraries":[]}')) : journey(() => 30)(url));
        const { result } = await run();
        const bar0 = result.candidates.find(c => c.name === 'Bar 0');
        assert.equal(bar0.score, null);
        assert.notEqual(result.candidates[result.best].name, 'Bar 0');
    });

    test('a failed journey is tried again once; failing twice marks the place incomplete', async () => {
        let bar0Calls = 0;
        globalThis.fetch = url => {
            if (barOf(url) === 0) {
                bar0Calls++;
                return Promise.resolve(new Response('oops', { status: 500 }));
            }
            return journey(() => 30)(url);
        };
        const { result, events } = await run({ participants: [participants[0], { ...participants[1], modes: ['transit'] }] });
        assert.equal(bar0Calls, 4); // 2 participants x 2 tries
        assert.equal(result.candidates.find(c => c.name === 'Bar 0').incomplete, true);
        assert.notEqual(result.candidates[result.best].name, 'Bar 0');
        assert.equal(events.filter(e => e.type === 'transit').at(-1).errors, 2);
    });

    test('a passing failure is not seen', async () => {
        const failed = new Set();
        globalThis.fetch = url => {
            if (!failed.has(url)) {
                failed.add(url);
                return Promise.resolve(new Response('oops', { status: 500 }));
            }
            return journey(() => 20)(url);
        };
        const { result } = await run({ maxCandidates: 1 });
        assert.equal(result.candidates[0].incomplete, false);
        assert.ok(result.candidates[0].score > 0);
    });

    test('cancelled: stops at once, no result, no further call', async () => {
        const stop = new AbortController();
        let started = 0;
        globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
            started++;
            if (started === 2) stop.abort();
            signal.addEventListener('abort', () => reject(signal.reason));
        });
        const events = [];
        const calls = { transitous: 0 };
        await assert.rejects(
            evaluate({ participants, slot: '19:00', categories: ['bar'], signal: stop.signal }, {}, data, calls, e => events.push(e)),
            { name: 'AbortError' },
        );
        const before = started;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(started, before);
        assert.ok(started < participants.length * 8);
        assert.ok(!events.some(e => e.type === 'result' || e.type === 'done'));
    });

    test('cancelled once the journeys are all there: still no result', async () => {
        const stop = new AbortController();
        const answer = journey(() => 10);
        let left = 2;
        globalThis.fetch = async url => {
            const res = await answer(url);
            if (--left === 0) stop.abort();
            return res;
        };
        const events = [];
        await assert.rejects(
            evaluate({ participants, slot: '19:00', categories: ['bar'], maxCandidates: 1, signal: stop.signal },
                {}, data, { transitous: 0 }, e => events.push(e)),
            { name: 'AbortError' },
        );
        assert.ok(!events.some(e => e.type === 'result'));
    });
});
