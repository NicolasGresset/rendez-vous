import { expect, test } from './support.mjs';

const results = app => app.page.locator('#location-results');
const progress = app => app.page.locator('#progress-text');
const submit = app => app.page.locator('#location-form [type="submit"]');
const pick = (app, selector) => app.page.evaluate(s => document.querySelector(s).click(), selector);

test('a computation proposes 3 places with everyone\'s trip', async ({ app }) => {
    await app.run();
    await expect(results(app)).toBeVisible();
    await expect(app.page.locator('.proposal')).toHaveCount(3);
    await expect(app.page.locator('.trip-card')).toHaveCount(3);
    await expect(progress(app)).toContainText('Terminé');
    await expect(app.page.locator('.proposal').first()).toHaveAttribute('aria-pressed', 'true');
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

test('choosing another proposal shows it, without a new transit call', async ({ app }) => {
    await app.run();
    await app.resetCalls();
    const second = app.page.locator('.proposal').nth(1);
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(app.page.locator('.trip-card')).toHaveCount(3);
    expect((await app.calls()).transit).toBe(0);
});

// What changes during a computation, its result then being of no use
const CHANGES = {
    'an address is edited': app => app.row(2).locator('[name="address"]').evaluate(input => {
        input.value = 'x';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
    'a mode is changed': app => app.row(0).locator('[name="modes"]').nth(2).evaluate(box => box.click()),
    'a place type is changed': app => pick(app, '[name="categories"][value="cafe"]'),
    'a participant is removed': app => app.row(2).locator('[data-action="remove"]').evaluate(button => button.click()),
};

for (const [name, change] of Object.entries(CHANGES)) {
    test(`when ${name} during a computation, it stops and shows nothing`, async ({ app }) => {
        // A real one takes tens of seconds: the answers are slowed so that the change falls during it
        await app.fill();
        await app.delay(300);
        await app.start();
        await expect.poll(async () => (await app.calls()).started).toBeGreaterThan(0);
        await change(app);
        await expect(progress(app)).toContainText('annulé');
        await expect(submit(app)).toBeEnabled();
        const { started, aborted } = await app.calls();
        expect(aborted).toBeGreaterThan(0);
        expect(started).toBeLessThan(24);
        // Long after: no more call, and still nothing shown
        await app.page.waitForTimeout(1000);
        expect((await app.calls()).started).toBe(started);
        await expect(results(app)).toBeHidden();
        await expect(app.page.locator('#location-status')).toBeHidden();

        // A new computation works
        if (name === 'a place type is changed') await pick(app, '[name="categories"][value="cafe"]');
        await app.delay(0);
        await app.run();
        await expect(results(app)).toBeVisible();
        await expect(app.page.locator('.trip-card')).toHaveCount(3);
    });
}

test('a slow computation left alone ends normally', async ({ app }) => {
    await app.fill();
    await app.delay(50);
    await app.start();
    await expect(progress(app)).toContainText('Terminé');
    await expect(results(app)).toBeVisible();
    expect((await app.calls()).aborted).toBe(0);
});

test('the paths of a result cleared meanwhile are dropped', async ({ app }) => {
    await app.run();
    await app.resetCalls();
    await app.delay(2000);
    await app.page.locator('.proposal').nth(1).click();
    await CHANGES['an address is edited'](app);
    await app.page.waitForTimeout(2500);
    await expect(results(app)).toBeHidden();
});

test('another score reranks from the known times, without a transit call', async ({ app }) => {
    await app.run();
    await app.resetCalls();
    await pick(app, '[name="score-metric"]:not(:checked)');
    await expect(results(app)).toBeVisible();
    await expect(app.page.locator('.proposal')).toHaveCount(3);
    expect((await app.calls()).transit).toBe(0);
});

test('the debug view shows the steps, every candidate and the calls', async ({ app }) => {
    await app.run();
    await pick(app, '[name="view-mode"][value="debug"]');
    await expect(app.page.locator('#place-select')).toBeVisible();
    await expect(app.page.locator('#progress-steps')).toBeVisible();
    await expect(app.page.locator('.progress-step[data-state="done"]')).toHaveCount(6);
    await expect(app.page.locator('#location-calls')).toContainText('Transitous');
    await pick(app, '[name="view-mode"]:not([value="debug"])');
    await expect(app.page.locator('#place-select')).toHaveCount(0);
});
