// The HTML of the results shows names coming from OpenStreetMap and from the transit services: never as HTML.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, formatDuration } from '../../js/labels.js';
import { choiceText, placeLinks, proposalsOf, resultsHtml, shareText } from '../../js/results.js';

const EVIL = '<img src=x onerror=alert(1)>';

test('formatDuration', () => {
    assert.equal(formatDuration(7 * 60), '7 min');
    assert.equal(formatDuration(65 * 60), '1 h 05');
    assert.equal(formatDuration(29), '0 min');
});

test('escapeHtml covers what could leave an attribute or open a tag', () => {
    assert.equal(escapeHtml(`<a href="x" id='y'>&`), '&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;');
});

test('choiceText: door-to-door time, or unreachable', () => {
    assert.equal(choiceText({ mode: 'walk', travel: 600 }), '10 min (marche)');
    assert.equal(choiceText(null), 'injoignable');
});

const SLOT = { from: '2026-11-03 19:00', to: '2026-11-03 19:10' };
const participant = { label: 'participant 1', color: '#2563EB', people: 1 };
const place = (name, extra = {}) => ({ id: 'node/1', name, category: 'amenity=bar', lat: 43.6, lon: 1.44, score: 600, street: 'Rue X', city: 'Toulouse',
    choices: [{ mode: 'walk', seconds: 600, travel: 600 }], times: [{ walk: { seconds: 600 } }], ...extra });
const result = (candidates, ranking = candidates.map((_, j) => j)) => ({ slot: SLOT, metric: 'half', participants: [participant], candidates, ranking, best: ranking[0] });
const LABELS = { 'amenity=bar': 'bar' };

test('a hostile place name stays text, in both views', () => {
    for (const debug of [false, true]) {
        const html = resultsHtml(result([place(EVIL)]), 0, LABELS, { debug });
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img'));
    }
});

test('hostile names of a transit journey stay text', () => {
    const trip = { departure: '2026-11-03T17:50:00Z', arrival: '2026-11-03T18:00:00Z', wait: 0, legs: [
        { kind: 'walk', seconds: 120, to: EVIL, departure: '2026-11-03T17:50:00Z', arrival: '2026-11-03T17:52:00Z' },
        { kind: 'line', seconds: 480, mode: 'bus', line: EVIL, headsign: EVIL, from: EVIL, to: EVIL, stops: 3, color: null,
            departure: '2026-11-03T17:52:00Z', arrival: '2026-11-03T18:00:00Z' },
    ] };
    const html = resultsHtml(result([place('Bar', { choices: [{ mode: 'transit', seconds: 600, travel: 600 }], times: [{ transit: { seconds: 600, trip } }] })]), 0, LABELS);
    assert.ok(!html.includes('<img'), html);
});

test('no place chosen: says why, by what was searched', () => {
    assert.match(resultsHtml({ ...result([]), best: null }, null, LABELS), /Aucun candidat trouvé/);
    assert.match(resultsHtml({ ...result([place('Bar', { score: null })], []), best: null }, null, LABELS), /atteignable par tous/);
});

test('a place with a failed journey says so', () => {
    const html = resultsHtml(result([place('Bar', { incomplete: true })]), 0, LABELS);
    assert.match(html, /Calcul incomplet/);
});

test('at most 3 proposals, unless the computation picked them', () => {
    const data = { ranking: [4, 3, 2, 1, 0] };
    assert.deepEqual(proposalsOf(data), [4, 3, 2]);
    assert.deepEqual(proposalsOf({ ...data, proposals: [1] }), [1]);
});

test('links: the OSM page of a place, a marker for a stop, encoded for Google', () => {
    const bar = placeLinks(place('Chez & Co'));
    assert.equal(bar.osm, 'https://www.openstreetmap.org/node/1');
    assert.ok(bar.google.includes('Chez%20%26%20Co'));
    const stop = placeLinks({ id: 'stop:1', name: 'Carmes', category: 'metro', lat: 43.6, lon: 1.44 });
    assert.ok(stop.osm.includes('mlat=43.6'));
    assert.ok(decodeURIComponent(stop.google).includes('Station de métro Carmes'));
});

test('the shared text gives the place and the meeting time', () => {
    assert.equal(shareText(place('Bar', { postcode: '31000' }), SLOT), 'Bar, Rue X, 31000 Toulouse — rendez-vous à 19:00');
});
