// The local search on the real places file: what must stay true whatever the weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createPlaceSearch } from '../../js/search.js';

const data = JSON.parse(fs.readFileSync(new URL('../../data/pois-toulouse.json', import.meta.url)));
const search = createPlaceSearch(data);
const CAPITOLE = { lat: 43.6045, lon: 1.4440 };
const first = query => search(query, CAPITOLE)[0];

test('a metro station comes before a nearer place of the same name', () => {
    assert.equal(first('jean jau').kind, data.categories.metro);
    assert.match(first('jean jau').name, /Jean Jaur/);
});

test('accents and case do not matter', () => {
    assert.equal(first('JEAN JAURES').name, first('jean jaurès').name);
});

test('typos still find the place', () => {
    for (const [typed, name] of [['capitolle', /Capitole/], ['esquriol', /Esquirol/], ['compnas', /Compans/]]) {
        assert.match(first(typed).name, name, typed);
    }
});

test('short words tolerate no typo', () => {
    assert.ok(search('zzz', CAPITOLE).length === 0);
});

test('at most 5 suggestions, each with a position', () => {
    const found = search('bar', CAPITOLE);
    assert.ok(found.length > 0 && found.length <= 5);
    found.forEach(place => assert.ok(Number.isFinite(place.lat) && Number.isFinite(place.lon)));
});
