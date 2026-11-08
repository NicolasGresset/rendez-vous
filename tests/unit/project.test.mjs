// The rules of the project that can be read from its files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const sources = fs.readdirSync(new URL('../../js/', import.meta.url)).map(name => read(`js/${name}`));
const csp = JSON.parse(read('vercel.json')).headers.find(h => h.source === '/(.*)').headers
    .find(h => h.key === 'Content-Security-Policy').value;
const directive = name => csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `));

// Hosts the page's code calls: in code, not in comments. Links the visitor follows are not calls
const LINKS = ['www.openstreetmap.org', 'www.google.com'];
const called = [...new Set(sources.flatMap(text => text.split('\n')
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .flatMap(line => [...line.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]+)/g)].map(m => m[1]))))]
    .filter(host => !LINKS.includes(host) && !host.includes('tile.'));

test('the page calls the services expected', () => {
    assert.deepEqual(called.sort(), ['api.rendez-vous.gresset-bourgeois.fr', 'data.geopf.fr']);
});

test('the page asks for no key', () => {
    const page = read('index.html');
    assert.ok(!/type="password"|obtenir une clé/.test(page));
    sources.forEach(text => assert.ok(!/api[_-]?key|localStorage/i.test(text)));
});

test('every service called is allowed by the Content-Security-Policy', () => {
    called.forEach(host => assert.ok(directive('connect-src').includes(`https://${host}`), host));
});

test('every service called is in the third-party list of the legal page', () => {
    const legal = read('legal.html');
    called.forEach(host => assert.ok(legal.includes(host), host));
});

test('no inline script allowed', () => {
    assert.ok(!directive('script-src').includes('unsafe'));
});

test('nothing for development is deployed', () => {
    const ignored = read('.vercelignore').split('\n');
    for (const path of ['scripts/', 'docs/', 'tests/', '.github/', 'package.json', 'package-lock.json', 'CLAUDE.md']) {
        assert.ok(ignored.includes(path), path);
    }
});

test('the site itself has no dependency', () => {
    const { dependencies = {} } = JSON.parse(read('package.json'));
    assert.deepEqual(dependencies, {});
});
