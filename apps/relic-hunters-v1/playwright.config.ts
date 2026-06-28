import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '../../tests/playwright/relic-hunters',
    timeout: 30_000,
    expect: {
        timeout: 5_000,
    },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? [['html'], ['list']] : [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5175',
        trace: 'on-first-retry',
    },
    webServer: {
        command:
            'cd ../.. && npm --workspace relic-hunters-v1 run dev -- --host 127.0.0.1',
        url: 'http://127.0.0.1:5175',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
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
