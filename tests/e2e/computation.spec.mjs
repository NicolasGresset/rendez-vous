import { expect, test } from './support.mjs';

const results = app => app.page.locator('#location-results');
const status = app => app.page.locator('#location-status');
const submit = app => app.page.locator('#location-form [type="submit"]');
const pick = (app, selector) => app.page.evaluate(s => document.querySelector(s).click(), selector);

test('a computation proposes 3 places with everyone\'s trip', async ({ app }) => {
    await app.run();
    await expect(results(app)).toBeVisible();
    await expect(app.page.locator('.proposal')).toHaveCount(3);
    await expect(app.page.locator('.trip-card')).toHaveCount(3);
    await expect(status(app)).toBeHidden();
    await expect(app.page.locator('.proposal').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(app.page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
});

test('the question sent is the form\'s', async ({ app }) => {
    await app.run();
    const { bodies } = await app.calls();
    expect(bodies).toHaveLength(1);
    const [question] = bodies;
    expect(question.placeType).toBe('restaurant');
    expect(question.meetingTime.slice(11)).toBe(app.scenario.slot);
    expect(question.participants.map(p => [...p.modes].sort())).toEqual(app.scenario.participants.map(p => [...p.modes].sort()));
    expect(question.participants[1].people).toBe(2);
});

test('only one place type at a time', async ({ app }) => {
    await pick(app, '[name="place-type"][value="cafe"]');
    await pick(app, '[name="place-type"][value="restaurant"]');
    const checked = await app.page.locator('[name="place-type"]:checked').evaluateAll(inputs => inputs.map(i => i.value));
    expect(checked).toEqual(['restaurant']);
});

test('a click anywhere on a card folds and unfolds it', async ({ app }) => {
    await app.run();
    const card = app.page.locator('.trip-card').first();
    const details = card.locator('details');
    await card.locator('.trip-card-title').click();
    await expect(details).toHaveJSProperty('open', true);
    await card.locator('.trip-card-title').click();
    await expect(details).toHaveJSProperty('open', false);
});

test('choosing another proposal shows it, without a new call', async ({ app }) => {
    await app.run();
    await app.resetCalls();
    const second = app.page.locator('.proposal').nth(1);
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(app.page.locator('.trip-card')).toHaveCount(3);
    expect((await app.calls()).started).toBe(0);
});

test('another place of the zone is asked when chosen, then shown', async ({ app }) => {
    await app.run();
    await app.resetCalls();
    await app.page.locator('.zone-others summary').click();
    await app.page.locator('.zone-other', { hasText: 'calculer' }).first().click();
    await expect(app.page.locator('.location-best')).toBeVisible();
    const { place, proposals, bodies } = await app.calls();
    expect([place, proposals]).toEqual([1, 0]);
    expect(typeof bodies[0].place).toBe('string');
});

test('another place that fails can be tried again', async ({ app }) => {
    await app.run();
    await app.fail('place', 'network');
    await app.page.locator('.zone-others summary').click();
    await app.page.locator('.zone-other', { hasText: 'calculer' }).first().click();
    await expect(app.page.locator('.zone-other', { hasText: 'échec' })).toHaveCount(1);
});

// What changes during a computation, its result then being of no use
const CHANGES = {
    'an address is edited': app => app.row(2).locator('[name="address"]').evaluate(input => {
        input.value = 'x';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
    'a mode is changed': app => app.row(0).locator('[name="modes"]').nth(2).evaluate(box => box.click()),
    'the place type is changed': app => pick(app, '[name="place-type"][value="cafe"]'),
    'a participant is removed': app => app.row(2).locator('[data-action="remove"]').evaluate(button => button.click()),
};

for (const [name, change] of Object.entries(CHANGES)) {
    test(`when ${name} during a computation, it stops and shows nothing`, async ({ app }) => {
        await app.fill();
        await app.delay(300);
        await app.start();
        await expect.poll(async () => (await app.calls()).started).toBeGreaterThan(0);
        await change(app);
        await expect(submit(app)).toBeEnabled();
        expect((await app.calls()).aborted).toBe(1);
        await expect(results(app)).toBeHidden();
        await expect(status(app)).toBeHidden();
    });
}

// What the API may answer, and what the visitor reads
const REFUSALS = {
    'too many computations': [{ status: 429, body: { error: 'rate_limited', retryAfter: 42 } }, 'réessayez dans 42 s'],
    'a long wait': [{ status: 429, body: { error: 'rate_limited', retryAfter: 3000 } }, 'réessayez dans 50 min'],
    'a busy service': [{ status: 503, body: { error: 'busy', retryAfter: 10 } }, 'réessayez dans 10 s'],
    'an engine down': [{ status: 503, body: { error: 'engine_unavailable' } }, 'momentanément indisponible'],
    'too long a computation': [{ status: 504, body: { error: 'timeout' } }, 'trop de temps'],
    'a time gone by': [{ status: 400, body: { error: 'time_out_of_range' } }, 'plus disponible'],
    'someone outside the area': [{ status: 400, body: { error: 'outside_area', participant: 1 } }, 'participant 2'],
    'no server': ['network', 'momentanément indisponible'],
};

for (const [name, [how, message]] of Object.entries(REFUSALS)) {
    test(`${name}: the visitor is told`, async ({ app }) => {
        await app.fill();
        await app.fail('proposals', how);
        await app.start();
        await expect(status(app)).toContainText(message);
        await expect(results(app)).toBeHidden();
        await expect(submit(app)).toBeEnabled();
    });
}

test('the connection is opened at the first use of the form, once', async ({ app }) => {
    expect((await app.calls()).health).toBe(0);
    await app.row(0).locator('[name="address"]').click();
    await expect.poll(async () => (await app.calls()).health).toBe(1);
    await app.row(1).locator('[name="address"]').click();
    await app.page.waitForTimeout(200);
    expect((await app.calls()).health).toBe(1);
});

test('a service that does not answer is told before the click, and forgotten when it answers', async ({ app }) => {
    await app.fail('health', 'network');
    await app.row(0).locator('[name="address"]').click();
    await expect(status(app)).toContainText('momentanément indisponible');
    await app.fail('health', null);
    await app.row(1).locator('[name="address"]').click();
    await expect(status(app)).toBeHidden();
});
