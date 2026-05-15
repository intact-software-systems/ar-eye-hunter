import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    timeout: 30_000,
    expect: {
        timeout: 10_000,
    },
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5176',
        trace: 'on-first-retry',
    },
    webServer: [
        {
            command: 'npm --workspace rallar-black-box run dev -- --host 127.0.0.1 --port 5176',
            url: 'http://127.0.0.1:5176',
            reuseExistingServer: true,
            timeout: 60_000,
        },
        {
            command: 'cd apps/rallar-black-box-control-server && deno task start',
            url: 'http://127.0.0.1:5180/health',
            reuseExistingServer: true,
            timeout: 60_000,
        },
    ],
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        '--enable-unsafe-swiftshader',
                        '--use-gl=angle',
                        '--use-angle=swiftshader',
                    ],
                },
            },
        },
    ],
});
