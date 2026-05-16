import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const fullStackEnabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
    process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            {
                command: 'cd ../.. && CORS_ORIGINS=http://127.0.0.1:5176,http://localhost:5176 deno run --env-file=.env --config apps/api-v1/deno.json --allow-net --allow-env --allow-read apps/api-v1/src/main.ts',
                url: 'http://localhost:8080/api/config',
                reuseExistingServer: true,
                timeout: 90_000,
            },
        ]
        : []),
    {
        command: 'cd ../.. && npm --workspace rallar-black-box run dev -- --host 127.0.0.1 --port 5176',
        url: 'http://127.0.0.1:5176',
        reuseExistingServer: true,
        timeout: 60_000,
    },
    {
        command: 'cd ../rallar-black-box-control-server && deno task start',
        url: 'http://127.0.0.1:5180/health',
        reuseExistingServer: true,
        timeout: 60_000,
    },
];

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: /full-stack-.*\.spec\.ts/,
    timeout: 90_000,
    expect: {
        timeout: 15_000,
    },
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5176',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
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
                        '--use-angle=swiftshader',
                    ],
                },
            },
        },
    ],
});
