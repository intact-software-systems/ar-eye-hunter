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
    webServer: [{
        command: 'npm run start:rallar',
        url: 'http://localhost:18084/api/config',
        env: { CCA_RALLAR_PORT: '18084', CCA_RALLAR_PUBLIC_URL: 'http://localhost:18084' },
        reuseExistingServer: !process.env.CI,
        timeout: 60000
    }, {
        command: 'npm run dev -- --host 127.0.0.1 --port 5182',
        url: 'http://127.0.0.1:5182',
        env: { VITE_RALLAR_API_BASE_URL: 'http://localhost:18084' },
        reuseExistingServer: !process.env.CI
    }]
});
