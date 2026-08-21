import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { createFullStackApiV1WebServer, readFullStackApiBaseUrl } from './playwright-full-stack-api-server.ts';

const exhaustiveWorkers = Number.parseInt(
    process.env.RALLAR_BLACK_BOX_EXHAUSTIVE_WORKERS ?? '4',
    10
);
const loginUserRateLimit = process.env.RALLAR_LOGIN_USER_RATE_LIMIT ?? '100';
const fullStackApiBaseUrl = readFullStackApiBaseUrl();
const reuseExistingServer = !process.env.CI;
const apiServer = createFullStackApiV1WebServer({
    mode: 'postgres',
    apiBaseUrl: fullStackApiBaseUrl,
    reuseExistingServer
});

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    {
        ...apiServer,
        command: apiServer.command.replace(
            'CORS_ORIGINS=',
            `RALLAR_LOGIN_USER_RATE_LIMIT=${loginUserRateLimit} CORS_ORIGINS=`
        )
    },
    {
        command: 'cd ../.. && npm --workspace rallar-black-box run dev -- --port 5176',
        url: 'http://localhost:5176',
        reuseExistingServer,
        timeout: 60_000
    },
    {
        command: 'cd ../rallar-black-box-control-server && deno task start',
        url: 'http://127.0.0.1:5180/health',
        reuseExistingServer,
        timeout: 60_000
    }
];

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: /exhaustive-.*\.spec\.ts/,
    fullyParallel: true,
    workers: Number.isFinite(exhaustiveWorkers) && exhaustiveWorkers > 0
        ? exhaustiveWorkers
        : 4,
    timeout: 180_000,
    expect: {
        timeout: 20_000
    },
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:5176',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
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
                        '--use-fake-device-for-media-stream',
                        '--use-fake-ui-for-media-stream'
                    ]
                }
            }
        }
    ]
});
