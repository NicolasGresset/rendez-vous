// location-fixture.js - A stored Rendez-vous computation, replayed in the browser to test the results' display and
// behaviour without any call to the API. Not deployed.
//
//   node scripts/location-fixture.js record   one real computation and one other place of a zone, through the dev
//                                             server, saved in scripts/fixtures/rendez-vous.json
//   node scripts/location-fixture.js shot     replays it, screenshots the results under SHOT_DIR
//
// From a test script:
//   const { withFirefox } = require('./scripts/firefox-bidi.js');
//   const { openWithFixture, runComputation } = require('./scripts/location-fixture.js');
//   await withFirefox(async page => {
//       const scenario = await openWithFixture(page);   // clock and API replaced, page loaded
//       await runComputation(page, scenario);           // form filled, computation done
//   });
//
// In the page (preload script, before any of its own): the clock is set back to the recording's instant (same day, same
// slots), and the calls to the API (/v1/, relayed by the dev server) get the recorded answers. Other origins are left
// alone: tests/e2e/support.mjs answers the address service and the map tiles. Needs the dev server on BASE_URL.

const fs   = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const FIXTURE_FILE = path.join(__dirname, 'fixtures/rendez-vous.json');
const TIMEOUT_MS = 120000;

// The scenario recorded: places typed in the address search (first local suggestion), modes, people, the place type (one
// whose zones are large, for another place of a zone) and the meeting time (when recording: the first quarter hour
// from an hour on, today's slots being only those to come)
const SCENARIO = {
    slot: '12:30',
    placeType: 'restaurant',
    participants: [
        { query: 'capitole', modes: ['walk', 'transit'], people: 1 },
        { query: 'ramonville', modes: ['transit', 'bike'], people: 2 },
        { query: 'blagnac aeroport', modes: ['transit', 'car'], people: 1 },
    ],
};

// Runs in the page before its scripts. fixture: { now, answers } (replay) or { now: null } (record: real clock, real
// calls, answers kept in window.__fixtureRecorded)
function preload(fixture) {
    if (location.origin !== new URL(fixture.baseUrl).origin) return;

    if (fixture.now != null) {
        const RealDate = Date;
        const shift = fixture.now - RealDate.now();
        class FixtureDate extends RealDate {
            constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + shift); }
            static now() { return RealDate.now() + shift; }
        }
        window.Date = FixtureDate;
    }

    const realFetch = window.fetch.bind(window);
    const recorded = window.__fixtureRecorded = {};
    window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/v1/')) return realFetch(input, init);
        if (fixture.now == null) {
            const res = await realFetch(input, init);
            recorded[url.pathname] = { status: res.status, text: await res.clone().text() };
            return res;
        }
        const answer = fixture.answers[url.pathname];
        if (url.pathname === '/v1/health') return new Response('{"status":"ok"}', { headers: { 'Content-Type': 'application/json' } });
        if (!answer) throw new Error(`fixture: no recorded answer for ${url.pathname}`);
        return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    };
}

// Installs the preload script and loads the page; record: real calls, kept for saving
async function openWithFixture({ send, context }, { record = false, url = `${BASE_URL}/` } = {}) {
    const fixture = record ? { now: null } : JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    const args = JSON.stringify({ baseUrl: BASE_URL, now: fixture.now, answers: fixture.answers });
    await send('script.addPreloadScript', { functionDeclaration: `() => (${preload})(${args})`, contexts: [context] });
    await send('browsingContext.navigate', { context, url, wait: 'complete' });
    return fixture.scenario || SCENARIO;
}

const until = async (evaluate, expression, what) => {
    const end = Date.now() + TIMEOUT_MS;
    while (!(await evaluate(expression))) {
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }
};

async function fillForm({ evaluate }, scenario = SCENARIO) {
    await until(evaluate, `document.querySelectorAll('#participants .participant').length >= 2`, 'participants');
    for (const [i, p] of scenario.participants.entries()) {
        await evaluate(`(() => {
            const rows = document.querySelectorAll('#participants .participant');
            if (rows.length <= ${i}) document.getElementById('add-participant').click();
            const row = document.querySelectorAll('#participants .participant')[${i}];
            row.querySelectorAll('[name="modes"]').forEach(c => { c.checked = ${JSON.stringify(p.modes)}.includes(c.value); });
            row.querySelector('[name="modes"]').dispatchEvent(new Event('change', { bubbles: true }));
            row.querySelector('[name="people"]').value = ${p.people};
            row.querySelector('[name="people"]').dispatchEvent(new Event('change', { bubbles: true }));
            const input = row.querySelector('[name="address"]');
            input.value = ${JSON.stringify(p.query)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        // The first local suggestion, before the Géoplateforme call is due
        await until(evaluate, `!document.querySelectorAll('#participants .participant')[${i}].querySelector('.address-options').hidden`, `suggestions ${i}`);
        await evaluate(`document.querySelectorAll('#participants .participant')[${i}].querySelector('[name="address"]')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    }
}

async function startComputation({ evaluate }, scenario = SCENARIO) {
    await evaluate(`(() => {
        document.querySelector('[name="place-type"][value=${JSON.stringify(scenario.placeType)}]').click();
        const li = [...document.querySelectorAll('#slot-options li')].find(li => li.textContent.startsWith(${JSON.stringify(scenario.slot)}));
        if (!li) throw new Error('slot ${scenario.slot} not offered');
        li.click();
        document.querySelector('#location-form [type="submit"]').click();
    })()`);
}

// Fills the form, starts the computation and waits for its end
async function runComputation(page, scenario = SCENARIO) {
    await fillForm(page, scenario);
    await startComputation(page, scenario);
    await until(page.evaluate, `!document.getElementById('location-results').hidden`, 'computation');
}

async function main(command) {
    const { withFirefox, SHOT_DIR } = require('./firefox-bidi.js');
    if (command === 'record') {
        const now = Date.now();
        SCENARIO.slot = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })
            .format(Math.ceil((now + 3600000) / 900000) * 900000);
        await withFirefox(async page => {
            await openWithFixture(page, { record: true });
            await runComputation(page);
            await page.evaluate(`[...document.querySelectorAll('.zone-other')].find(b => b.textContent.includes('calculer')).click()`);
            await until(page.evaluate, `!!window.__fixtureRecorded['/v1/place']`, 'another place');
            const answers = JSON.parse(await page.evaluate('JSON.stringify(window.__fixtureRecorded)'));
            fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
            fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify({ recorded: new Date(now).toISOString(), now, scenario: SCENARIO, answers }, null, 1)}\n`);
            console.log(`${Object.keys(answers).join(', ')} saved in ${FIXTURE_FILE}`);
            if (page.errors.length) console.log('page errors:', page.errors);
        });
    } else if (command === 'shot') {
        await withFirefox(async page => {
            await runComputation(page, await openWithFixture(page));
            console.log(await page.screenshot('rendez-vous-results.png', '#location-results'));
            if (page.errors.length) console.log('page errors:', page.errors);
        });
        console.log(`screenshots in ${SHOT_DIR}`);
    } else {
        console.log('usage: node scripts/location-fixture.js record|shot');
    }
}

if (require.main === module) main(process.argv[2]).catch(err => { console.error(err); process.exitCode = 1; });

module.exports = { preload, openWithFixture, fillForm, startComputation, runComputation, SCENARIO, FIXTURE_FILE, BASE_URL };
