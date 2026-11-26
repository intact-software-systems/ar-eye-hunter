import { defineConfig } from '@playwright/test';

export default defineConfig({
    outputDir: '../../tmp/grumpy-town-playwright',
    testDir: '../../tests/playwright/grumpy-town',
    timeout: 30_000,
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:5182',
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        channel: process.platform === 'darwin' ? 'chromium' : undefined,
        launchOptions: { args: [
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
            ...(process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader'])
        ] },
        screenshot: 'only-on-failure'
    },
    webServer: [{
        command: 'npm run start:rallar',
        url: 'http://localhost:18084/api/config',
        env: { GRUMPY_TOWN_RALLAR_PORT: '18084', GRUMPY_TOWN_RALLAR_PUBLIC_URL: 'http://localhost:18084' },
        reuseExistingServer: !process.env.CI,
        timeout: 60000
    }, {
        command: 'npm run dev -- --mode test --host 127.0.0.1 --port 5182',
        url: 'http://127.0.0.1:5182',
        env: { VITE_RALLAR_API_BASE_URL: 'http://localhost:18084' },
        reuseExistingServer: !process.env.CI
    }]
});
