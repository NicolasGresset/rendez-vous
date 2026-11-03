// Browser tests (tests/e2e): the page served by the dev server, API answers replayed from the fixture, so
// no call to any service and no quota. WebKit needs system libraries: on GitHub only (CI is set there).
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
    testDir: 'tests/e2e',
    testMatch: '*.spec.mjs',
    timeout: 60000,
    forbidOnly: CI,
    retries: 0,
    workers: CI ? 2 : undefined,
    reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: { baseURL: 'http://localhost:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    webServer: { command: 'node scripts/dev-server.js', url: 'http://localhost:3001', reuseExistingServer: !CI },
    projects: [
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
        ...(CI ? [{ name: 'mobile-safari', use: { ...devices['iPhone 15'] } }] : []),
    ],
});
