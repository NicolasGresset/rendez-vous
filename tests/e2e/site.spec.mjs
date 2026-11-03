import { expect, test } from '@playwright/test';

test('the legal page is served at its clean URL, with the Content-Security-Policy', async ({ page, request }) => {
    const response = await page.goto('/legal');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
    await expect(page.locator('h1')).toBeVisible();
    const old = await request.get('/legal.html', { maxRedirects: 0 });
    expect(old.status()).toBe(308);
});

test('the page loads nothing from a third party but the map tiles', async ({ page }) => {
    const hosts = new Set();
    page.on('request', r => hosts.add(new URL(r.url()).hostname));
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    hosts.delete('tile.openstreetmap.org');
    hosts.delete('localhost');
    expect([...hosts]).toEqual([]);
});
