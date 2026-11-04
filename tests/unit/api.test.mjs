// The relays holding the site's keys (api/), and the page's calls to them: fetch replaced, no API call.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { POST as orsRelay } from '../../api/ors.mjs';
import { POST as tisseoRelay } from '../../api/tisseo.mjs';
import { durationMatrix } from '../../js/ors.js';
import { tisseoTrip, TisseoKeyError } from '../../js/tisseo.js';

const SECRET = 'secret-key';
const realFetch = globalThis.fetch;
const post = body => new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });
const JOURNEY = { departurePlaceXY: '1.44,43.6', arrivalPlaceXY: '1.45,43.61', firstDepartureDatetime: '2026-11-04 18:00', number: '4' };

afterEach(() => { globalThis.fetch = realFetch; });

describe('openrouteservice relay', () => {
    let upstream;
    beforeEach(() => {
        process.env.OPENROUTESERVICE_API_KEY = SECRET;
        upstream = [];
        globalThis.fetch = async (url, init) => {
            upstream.push({ url, init });
            return new Response('{"durations":[]}', { headers: { 'x-ratelimit-remaining': '42' } });
        };
    });

    test('adds the key, relays the answer and the quota, without the key in the answer', async () => {
        const res = await orsRelay(post({ path: 'matrix/foot-walking', body: { metrics: ['duration'] } }));
        assert.equal(upstream[0].url, 'https://api.openrouteservice.org/v2/matrix/foot-walking');
        assert.equal(upstream[0].init.headers.Authorization, SECRET);
        assert.equal(upstream[0].init.body, '{"metrics":["duration"]}');
        assert.equal(res.headers.get('x-ratelimit-remaining'), '42');
        assert.equal(await res.text(), '{"durations":[]}');
    });

    test('only the services the page uses', async () => {
        for (const path of ['isochrones/foot-walking', 'matrix/foot-walking/../../secret', 'directions/foot-walking', undefined]) {
            assert.equal((await orsRelay(post({ path, body: {} }))).status, 400, path);
        }
        assert.equal(upstream.length, 0);
    });

    test('an error\'s body is not relayed: it might repeat the key', async () => {
        globalThis.fetch = async () => new Response(`refused: ${SECRET}`, { status: 403 });
        const res = await orsRelay(post({ path: 'matrix/foot-walking', body: {} }));
        assert.equal(res.status, 403);
        assert.equal(await res.text(), '');
    });

    test('no key configured: 401, nothing called', async () => {
        delete process.env.OPENROUTESERVICE_API_KEY;
        assert.equal((await orsRelay(post({ path: 'matrix/foot-walking', body: {} }))).status, 401);
        assert.equal(upstream.length, 0);
    });
});

describe('Tisséo relay', () => {
    let upstream;
    beforeEach(() => {
        process.env.TISSEO_API_KEY = SECRET;
        upstream = [];
        globalThis.fetch = async url => {
            upstream.push(new URL(url));
            return new Response('<journeys/>');
        };
    });

    test('adds the key, relays the fields and the answer', async () => {
        const res = await tisseoRelay(post(JOURNEY));
        assert.equal(upstream[0].origin + upstream[0].pathname, 'https://api.tisseo.fr/v2/journeys.xml');
        assert.equal(upstream[0].searchParams.get('key'), SECRET);
        assert.equal(upstream[0].searchParams.get('arrivalPlaceXY'), '1.45,43.61');
        assert.equal(await res.text(), '<journeys/>');
    });

    test('a badly formed field or a smuggled parameter is refused', async () => {
        for (const change of [{ number: '500' }, { departurePlaceXY: '1,2&key=other' }, { firstDepartureDatetime: undefined }]) {
            assert.equal((await tisseoRelay(post({ ...JOURNEY, ...change }))).status, 400, JSON.stringify(change));
        }
        assert.equal(upstream.length, 0);
    });

    test('an extra field does not reach Tisséo', async () => {
        await tisseoRelay(post({ ...JOURNEY, key: 'other', roadMode: 'car' }));
        assert.equal(upstream[0].searchParams.get('key'), SECRET);
        assert.equal(upstream[0].searchParams.get('roadMode'), null);
    });

    test('an error\'s body is not relayed, no key configured: 401', async () => {
        globalThis.fetch = async () => new Response(`refused: ${SECRET}`, { status: 403 });
        const refused = await tisseoRelay(post(JOURNEY));
        assert.equal(refused.status, 403);
        assert.equal(await refused.text(), '');
        delete process.env.TISSEO_API_KEY;
        assert.equal((await tisseoRelay(post(JOURNEY))).status, 401);
    });
});

describe('the page\'s calls', () => {
    const from = { lat: 43.6, lon: 1.44 };
    const to = { lat: 43.61, lon: 1.45 };

    test('openrouteservice through the relay, no key sent', async () => {
        let call;
        globalThis.fetch = async (url, init) => {
            call = { url, init };
            return new Response('{"durations":[[60]]}');
        };
        const { durations } = await durationMatrix('walk', [from], [to]);
        assert.equal(call.url, '/api/ors');
        assert.equal(JSON.parse(call.init.body).path, 'matrix/foot-walking');
        assert.equal(call.init.headers.Authorization, undefined);
        assert.deepEqual(durations, [[60]]);
    });

    test('Tisséo through the relay, no key sent; a 401 stops the computation', async () => {
        let call;
        globalThis.fetch = async (url, init) => {
            call = { url, init };
            return new Response(null, { status: 401 });
        };
        await assert.rejects(tisseoTrip(() => {}, from, to, '2026-11-04 19:00', '2026-11-04 19:10'), TisseoKeyError);
        assert.equal(call.url, '/api/tisseo');
        const fields = JSON.parse(call.init.body);
        assert.equal(fields.departurePlaceXY, '1.44,43.6');
        assert.equal(fields.key, undefined);
    });
});
