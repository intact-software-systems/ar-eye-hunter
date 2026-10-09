import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { loadLiveRtcPerformanceAttempt } from '../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';
import {
    createFullStackApiV1WebServer,
    portFromBaseUrl,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl
} from './playwright-full-stack-api-server.ts';
import {
    createFullStackControlWebServer,
    readFullStackControlBaseUrl
} from './playwright-full-stack-control-server.ts';

const fullStackEnabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
    process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';
const fullStackApiBaseUrl = readFullStackApiBaseUrl();
const fullStackSpaBaseUrl = readFullStackSpaBaseUrl();
const fullStackControlBaseUrl = readFullStackControlBaseUrl();
const fullStackApiServerMode = fullStackEnabled
    ? readFullStackApiServerMode()
    : 'postgres';
const reuseExistingServer = !process.env.CI;
const requireFreshPostgresApi = [
    '1',
    'true'
].includes(
    process.env.RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API?.trim().toLowerCase() ?? ''
);
const liveRtcClusterEnabled = process.env.RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER === '1';
const clusterApiBaseUrls = [
    process.env.VITE_RALLAR_API_BASE_URL_B,
    process.env.VITE_RALLAR_API_BASE_URL_C
].filter((url): url is string => Boolean(url));
if (liveRtcClusterEnabled && (fullStackApiServerMode !== 'postgres' || clusterApiBaseUrls.length !== 2)) {
    throw new Error('Live RTC cluster proof requires Postgres and distinct B/C API base URLs.');
}

// The test composition root admits the complete predeclared selection before
// constructing any API, SPA or control server configuration.
const admittedRtcAttempt = fullStackEnabled
    ? await loadLiveRtcPerformanceAttempt({
        repoRoot: fileURLToPath(new URL('../../', import.meta.url)),
        environment: process.env
    })
    : null;

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            createFullStackApiV1WebServer({
                mode: fullStackApiServerMode,
                apiBaseUrl: fullStackApiBaseUrl,
                spaBaseUrl: fullStackSpaBaseUrl,
                reuseExistingServer,
                requireFreshPostgres: requireFreshPostgresApi,
                admittedRtcCaseId: admittedRtcAttempt?.locator.caseId ?? null,
                environment: process.env
            }),
            ...(liveRtcClusterEnabled
                ? clusterApiBaseUrls.map((apiBaseUrl) =>
                    createFullStackApiV1WebServer({
                        mode: 'postgres',
                        apiBaseUrl,
                        spaBaseUrl: fullStackSpaBaseUrl,
                        reuseExistingServer,
                        requireFreshPostgres: requireFreshPostgresApi,
                        admittedRtcCaseId: admittedRtcAttempt?.locator.caseId ?? null,
                        environment: process.env
                    })
                )
                : [])
        ]
        : []),
    {
        command: `cd ../.. && npm --workspace rallar-black-box run dev -- --port ${
            portFromBaseUrl(fullStackSpaBaseUrl)
        } --force`,
        env: {
            VITE_RALLAR_API_BASE_URL: fullStackApiBaseUrl
        },
        url: fullStackSpaBaseUrl,
        reuseExistingServer,
        timeout: 60_000
    },
    createFullStackControlWebServer({
        baseUrl: fullStackControlBaseUrl,
        reuseExistingServer
    })
];

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: /full-stack-.*\.spec\.ts/,
    timeout: 90_000,
    expect: {
        timeout: 15_000
    },
    reporter: [['list', { printSteps: true }]],
    use: {
        baseURL: fullStackSpaBaseUrl,
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
