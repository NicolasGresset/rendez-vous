// From the form to the question, and from the API's answer to what the page shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePolyline, legOf, placeOf, questionOf, resultOf } from '../../js/answer.js';
import { errorMessage } from '../../js/api.js';

test('the question keeps only what the API accepts', () => {
    const participants = [{ lat: 43.6, lon: 1.44, modes: ['walk'], people: 2, label: 'participant 1', color: '#000', row: {} }];
    assert.deepEqual(questionOf(participants, 'bar', '19:15', '2026-11-08'), {
        meetingTime: '2026-11-08T19:15', placeType: 'bar', participants: [{ lat: 43.6, lon: 1.44, modes: ['walk'], people: 2 }],
    });
});

test('polylines are decoded, at their precision', () => {
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
    assert.deepEqual(decodePolyline('', 7), []);
});

const AT = { departure: '2026-11-08T18:00:00Z', arrival: '2026-11-08T18:05:00Z' };

test('a leg: a walk, a street leg, a line named in French', () => {
    assert.equal(legOf({ mode: 'WALK', ...AT }).kind, 'walk');
    assert.equal(legOf({ mode: 'WALK', ...AT }).seconds, 300);
    assert.deepEqual(legOf({ mode: 'WALK', ...AT }).path, []);
    assert.equal(legOf({ mode: 'BIKE', ...AT }).kind, 'street');
    const line = legOf({ mode: 'SUBWAY', line: 'B', headsign: 'Ramonville', color: '#FFCD00', stops: 3, from: 'A', to: 'B', ...AT });
    assert.deepEqual([line.kind, line.mode, line.line, line.color, line.stops], ['line', 'métro', 'B', '#FFCD00', 3]);
    assert.equal(legOf({ mode: 'FUNICULAR_NEW', ...AT }).mode, 'funicular_new');
});

const PARTICIPANTS = [{ label: 'participant 1', color: '#000', people: 1 }, { label: 'participant 2', color: '#111', people: 1 }];
const transitTrip = { mode: 'transit', seconds: 1260, travel: 1140, departure: '2026-11-08T17:39:00Z', arrival: '2026-11-08T17:58:00Z',
    legs: [{ mode: 'BUS', line: 'L1', ...AT, path: { points: '_p~iF~ps|U', precision: 5 } }] };
const bikeTrip = { mode: 'bike', seconds: 960, travel: 960, legs: [{ mode: 'BIKE', ...AT }] };
const place = (id, zone, score = 1185) => ({ id, name: id, category: 'amenity=bar', lat: 43.6, lon: 1.44, street: 'Rue X', zone, score, trips: [transitTrip, bikeTrip] });
const ANSWER = {
    meetingTime: '2026-11-08T19:00',
    proposals: [0, 2],
    zones: [{ name: 'Carmes', kind: 'bar', places: [0, 1], others: [{ id: 'node/9', name: 'Autre', category: 'amenity=pub', lat: 43.59, lon: 1.45 }] },
        { name: 'Compans', kind: 'bar', places: [2], others: [] }],
    places: [place('a', 0), place('b', 0, 1300), place('c', 1, 1400)],
    data: {},
};

test('the answer becomes candidates, proposals and the best', () => {
    const data = resultOf(ANSWER, PARTICIPANTS, '19:00');
    assert.deepEqual(data.proposals, [0, 2]);
    assert.equal(data.best, 0);
    assert.equal(data.slot.from, '2026-11-08 19:00');
    assert.equal(data.candidates.length, 4);
    const [a] = data.candidates;
    assert.deepEqual(a.zoneInfo, { index: 0, name: 'Carmes', kind: 'bar' });
    assert.equal(a.street, 'Rue X');
    assert.deepEqual(a.choices[0], { mode: 'transit', seconds: 1260, travel: 1140 });
    assert.equal(a.journeys[0].wait, 120);
    assert.equal(a.journeys[1], null);
    assert.equal(a.routes[1].mode, 'bike');
    assert.equal(a.routes[0].legs[0].kind, 'line');
    assert.deepEqual(a.routes[0].legs[0].path, [[38.5, -120.2]]);
});

test('a zone\'s place without times is pending; a station has no zone', () => {
    const data = resultOf({ ...ANSWER, places: [...ANSWER.places, place('s', undefined)] }, PARTICIPANTS, '19:00');
    const pending = data.candidates.at(-1);
    assert.deepEqual([pending.id, pending.pending, pending.score, pending.zoneInfo.name], ['node/9', true, null, 'Carmes']);
    assert.equal(data.candidates[3].zoneInfo, null);
});

test('no place: no best', () => {
    const data = resultOf({ ...ANSWER, proposals: [], zones: [], places: [] }, PARTICIPANTS, '19:00');
    assert.equal(data.best, null);
    assert.deepEqual(data.candidates, []);
});

test('a trip without legs has no path, and says so', () => {
    const data = resultOf({ ...ANSWER, places: [{ ...place('a', 0), trips: [{ ...bikeTrip, legs: [] }, bikeTrip] }] }, PARTICIPANTS, '19:00');
    assert.deepEqual(data.candidates[0].routes[0], { mode: 'bike', legs: null, error: 'tracé indisponible' });
});

test('another place: its trips, or no score when someone cannot reach it', () => {
    const pending = { id: 'node/9', zoneInfo: { index: 0, name: 'Carmes', kind: 'bar' }, pending: true };
    const reached = placeOf({ place: { ...place('node/9'), reachable: true, score: 900 } }, pending);
    assert.deepEqual([reached.score, reached.pending, reached.zoneInfo.name], [900, false, 'Carmes']);
    const missed = placeOf({ place: { ...place('node/9'), reachable: false, score: undefined, trips: [null, bikeTrip] } }, pending);
    assert.equal(missed.score, null);
    assert.equal(missed.choices[0], null);
    assert.equal(missed.routes[0].error, 'injoignable');
});

test('the API\'s errors in French', () => {
    assert.match(errorMessage({ error: 'rate_limited', retryAfter: 42 }), /42 s/);
    assert.match(errorMessage({ error: 'rate_limited', retryAfter: 3000 }), /50 min/);
    assert.match(errorMessage({ error: 'busy', retryAfter: 10 }), /en ce moment/);
    assert.match(errorMessage({ error: 'outside_area', participant: 2 }), /participant 3/);
    assert.match(errorMessage({ error: 'invalid_people', participant: 0 }), /participant 1/);
    assert.match(errorMessage({ error: 'anything else' }), /indisponible/);
    assert.match(errorMessage({}), /indisponible/);
});
