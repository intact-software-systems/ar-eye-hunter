import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const fullStackEnabled = process.env.RELIC_HUNTERS_FULL_STACK === '1' ||
    process.env.RELIC_HUNTERS_FULL_STACK === 'true';

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            {
                command:
                    'cd ../relic-hunter-server-v1 && CORS_ORIGINS=http://localhost:5175,http://127.0.0.1:5175 PORT=8090 deno task start',
                url: 'http://127.0.0.1:8090/api/config',
                reuseExistingServer: true,
                timeout: 90_000
            }
        ]
        : []),
    {
        command:
            'cd ../.. && API_BASE_URL=http://127.0.0.1:8090 npm --workspace relic-hunters-v1 run dev -- --host 127.0.0.1',
        url: 'http://127.0.0.1:5175',
        reuseExistingServer: true,
        timeout: 60_000
    }
];

export default defineConfig({
    testDir: '../../tests/playwright/relic-hunters',
    testMatch: /full-stack-.*\.spec\.ts/,
    timeout: 120_000,
    expect: {
        timeout: 15_000
    },
    fullyParallel: false,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5175',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure'
    },
    webServer,
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        '--enable-unsafe-swiftshader',
                        '--use-gl=angle',
                        '--use-angle=swiftshader'
                    ]
                }
            }
        }
    ]
});
