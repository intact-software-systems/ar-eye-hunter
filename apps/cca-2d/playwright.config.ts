import { defineConfig } from '@playwright/test';

export default defineConfig({
    outputDir: '../../tmp/cca-playwright',
    testDir: '../../tests/playwright/cca-2d',
    timeout: 30_000,
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:5182',
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        launchOptions: { args: ['--enable-unsafe-swiftshader'] },
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 5182',
        url: 'http://127.0.0.1:5182',
        reuseExistingServer: !process.env.CI
    }
});
