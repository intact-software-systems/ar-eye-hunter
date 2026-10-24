import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.RALLAR_ARENA_DEPLOYED_URL;
if (!baseURL || new URL(baseURL).protocol !== 'https:') {
    throw new Error('RALLAR_ARENA_DEPLOYED_URL must identify the HTTPS SPA deployment to verify.');
}

export default defineConfig({
    testDir: '../../tests/playwright/ar-eye-hunter',
    testMatch: '**/deployed-quick-join.spec.ts',
    outputDir: '../../tmp/playwright/deployed-quick-join',
    timeout: 120_000,
    expect: { timeout: 20_000 },
    workers: 1,
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL,
        // Authentication requests must not enter a downloadable trace.
        trace: 'off',
        screenshot: 'only-on-failure'
    }
});
