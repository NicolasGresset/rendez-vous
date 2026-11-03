// The page with the stored computation (scripts/location-fixture.js): API answers replayed, no third-party
// call at all (map tiles included), and every page error or CSP violation fails the test.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test as base, expect } from '@playwright/test';

const require = createRequire(import.meta.url);
const fixtureTools = require('../../scripts/location-fixture.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

// After the fixture's own: Géoplateforme answered here, API answers slowed by window.__delay, and counted
function instrument() {
    const replayed = window.fetch;
    window.__calls = { started: 0, transit: 0, aborted: 0 };
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', e => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin === location.origin) return replayed(input, init);
        if (url.hostname === 'data.geopf.fr') {
            if (url.pathname.includes('reverse')) return Promise.resolve(json({ features: [{ properties: { label: '1 Rue du Test 31000 Toulouse' } }] }));
            const text = url.searchParams.get('text');
            return Promise.resolve(json({ results: text.includes('zzservice') ? [{ fulltext: `<img src=x>${text} 31000 Toulouse`, kind: 'housenumber', x: 1.45, y: 43.6 }] : [] }));
        }
        window.__calls.started++;
        if (url.hostname === 'api.transitous.org') window.__calls.transit++;
        return new Promise((resolve, reject) => {
            let settled = false;
            const end = (done, value) => { settled = true; done(value); };
            const timer = setTimeout(() => replayed(input, init).then(v => end(resolve, v), e => end(reject, e)), window.__delay || 0);
            init.signal?.addEventListener('abort', () => {
                if (settled) return; // the timeout of a call already answered
                clearTimeout(timer);
                window.__calls.aborted++;
                end(reject, init.signal.reason);
            });
        });
    };
}

export const test = base.extend({
    // The page, loaded; fails at the end on any page error or Content-Security-Policy violation
    app: async ({ page }, use) => {
        const errors = [];
        page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
        // Without a local MOTIS, the dev server's relay answers 502: only on the developer's machine
        page.on('console', m => { if (m.type() === 'error' && !m.location().url.includes('/motis/')) errors.push(`console: ${m.text()}`); });
        await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: PNG }));
        const fixture = JSON.parse(fs.readFileSync(fixtureTools.FIXTURE_FILE, 'utf8'));
        await page.addInitScript(fixtureTools.preload, { baseUrl: fixtureTools.BASE_URL, now: fixture.now, responses: fixture.responses });
        await page.addInitScript(instrument);
        await page.goto('/');
        await expect(page.locator('#participants .participant')).toHaveCount(3);
        const driver = { evaluate: expression => page.evaluate(expression) };
        const scenario = fixture.scenario;
        await use({
            page,
            row: i => page.locator('#participants .participant').nth(i),
            fill: () => fixtureTools.fillForm(driver, scenario),
            start: () => fixtureTools.startComputation(driver, scenario),
            run: () => fixtureTools.runComputation(driver, scenario),
            delay: ms => page.evaluate(value => { window.__delay = value; }, ms),
            calls: () => page.evaluate(() => window.__calls),
            resetCalls: () => page.evaluate(() => { window.__calls = { started: 0, transit: 0, aborted: 0 }; }),
        });
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => window.__violations)).toEqual([]);
    },
});

export { expect };
