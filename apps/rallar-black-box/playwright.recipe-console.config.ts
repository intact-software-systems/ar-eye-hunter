import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: /recipe-console-.*\.spec\.ts/,
    timeout: 30_000,
    use: {
        baseURL: 'http://127.0.0.1:5176',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 5176',
        cwd: '.',
        url: 'http://127.0.0.1:5176',
        reuseExistingServer: true,
    },
});
