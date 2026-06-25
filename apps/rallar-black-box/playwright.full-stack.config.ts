import { defineConfig, devices, type PlaywrightTestConfig, } from '@playwright/test';
import {
    createFullStackApiV1WebServer,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl,
    portFromBaseUrl,
} from './playwright-full-stack-api-server.ts';

const fullStackEnabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
    process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';
const fullStackApiBaseUrl = readFullStackApiBaseUrl();
const fullStackSpaBaseUrl = readFullStackSpaBaseUrl();
const fullStackApiServerMode = fullStackEnabled
    ? readFullStackApiServerMode()
    : 'postgres';
const reuseExistingServer = !process.env.CI;

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            createFullStackApiV1WebServer({
                mode: fullStackApiServerMode,
                apiBaseUrl: fullStackApiBaseUrl,
                spaBaseUrl: fullStackSpaBaseUrl,
                reuseExistingServer,
            }),
        ]
        : []),
    {
        command:
            `cd ../.. && npm --workspace rallar-black-box run dev -- --port ${portFromBaseUrl(fullStackSpaBaseUrl)} --force`,
        url: fullStackSpaBaseUrl,
        reuseExistingServer,
        timeout: 60_000,
    },
    {
        command: 'cd ../rallar-black-box-control-server && deno task start',
        url: 'http://127.0.0.1:5180/health',
        reuseExistingServer,
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
        baseURL: fullStackSpaBaseUrl,
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
