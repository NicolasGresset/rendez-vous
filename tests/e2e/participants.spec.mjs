import { expect, test } from './support.mjs';

const address = (app, i) => app.row(i).locator('[name="address"]');
const options = (app, i) => app.row(i).locator('.address-options li[data-index]');

test('suggestions: local places, chosen with the keyboard', async ({ app }) => {
    await address(app, 0).fill('capitole');
    await expect(options(app, 0).first()).toBeVisible();
    await address(app, 0).press('ArrowDown');
    await expect(options(app, 0).first()).toHaveAttribute('aria-selected', 'true');
    await address(app, 0).press('Enter');
    await expect(app.row(0)).toHaveClass(/participant--located/);
    await expect(app.page.locator('.participant-marker')).toHaveCount(1);
    await expect(app.row(0).locator('.participant-hint')).toContainText('position');
});

test('suggestions: chosen with a click; Escape closes the list', async ({ app }) => {
    await address(app, 1).fill('ramonville');
    await expect(options(app, 1).first()).toBeVisible();
    await address(app, 1).press('Escape');
    await expect(options(app, 1).first()).toBeHidden();
    await address(app, 1).fill('ramonvill');
    await options(app, 1).first().click();
    await expect(app.row(1)).toHaveClass(/participant--located/);
});

test('suggestions of the address service come after the local ones, as text', async ({ app }) => {
    await address(app, 0).fill('zzservice');
    await expect(app.row(0).locator('.address-options')).toContainText('<img src=x>zzservice');
    await expect(app.row(0).locator('.address-options img')).toHaveCount(0);
});

test('editing an address erases the position', async ({ app }) => {
    await address(app, 0).fill('capitole');
    await address(app, 0).press('Enter');
    await expect(app.page.locator('.participant-marker')).toHaveCount(1);
    await address(app, 0).fill('capitol');
    await expect(app.row(0)).not.toHaveClass(/participant--located/);
    await expect(app.page.locator('.participant-marker')).toHaveCount(0);
});

test('a click on the map places the active participant, the address follows', async ({ app }) => {
    await app.row(1).locator('.participant-legend').click();
    await app.page.locator('#location-map').click({ position: { x: 120, y: 120 } });
    await expect(app.row(1)).toHaveClass(/participant--located/);
    await expect(address(app, 1)).toHaveValue('1 Rue du Test 31000 Toulouse');
});

test('computers: dragging a point moves the participant', async ({ app, page }) => {
    test.skip(!await page.evaluate(() => matchMedia('(pointer: fine)').matches), 'no dragging on touch screens');
    await address(app, 0).fill('capitole');
    await address(app, 0).press('Enter');
    const marker = page.locator('.participant-marker');
    const before = await app.row(0).getAttribute('data-lat');
    const box = await marker.boundingBox();
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 72, box.y + 52, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => app.row(0).getAttribute('data-lat')).not.toBe(before);
});

test('touch screens: points cannot be dragged', async ({ app, page }) => {
    test.skip(await page.evaluate(() => matchMedia('(pointer: fine)').matches), 'computers only');
    await address(app, 0).fill('capitole');
    await address(app, 0).press('Enter');
    await expect(page.locator('.participant-marker--draggable')).toHaveCount(0);
});

test('people: the chip opens a stepper counting from 1', async ({ app }) => {
    const row = app.row(0);
    const people = row.locator('[name="people"]');
    await row.locator('[data-action="people-open"]').click();
    await row.locator('[data-action="people-more"]').click();
    await expect(people).toHaveValue('2');
    await row.locator('[data-action="people-less"]').click();
    await expect(people).toHaveValue('1');
    await expect(row.locator('[data-action="people-less"]')).toBeDisabled();
});

test('at least two participants; a typed address must be chosen', async ({ app }) => {
    const status = app.page.locator('#location-status');
    await address(app, 0).fill('capitole');
    await address(app, 0).press('Enter');
    await app.page.locator('#location-form [type="submit"]').click();
    await expect(status).toContainText('au moins deux');
    await address(app, 1).fill('pas choisie');
    await address(app, 1).press('Escape');
    await app.page.locator('#location-form [type="submit"]').click();
    await expect(status).toContainText('Choisissez une adresse');
});

test('at most 5 participants with the public services', async ({ app }) => {
    const add = app.page.locator('#add-participant');
    await add.click();
    await add.click();
    await expect(app.page.locator('#participants .participant')).toHaveCount(5);
    await expect(add).toBeHidden();
});

test('a new participant walks or takes the bus, no key asked', async ({ app }) => {
    const { page } = app;
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    const modes = await app.row(0).locator('[name="modes"]:checked').evaluateAll(boxes => boxes.map(box => box.value));
    expect(modes.sort()).toEqual(['transit', 'walk']);
});
