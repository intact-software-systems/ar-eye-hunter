import {
    defineConfig,
    devices,
    type PlaywrightTestConfig
} from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { loadLiveRtcPerformanceAttempt } from '../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

import {
    createDefaultFullStackApiV1WebServer,
    portFromBaseUrl,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl
} from './playwright-full-stack-api-server.ts';
import {
    createFullStackControlWebServer,
    readFullStackControlBaseUrl
} from './playwright-full-stack-control-server.ts';
import {
    createDefaultFullStackRtcProductionDependencies,
    createFullStackRtcPreviewServer,
    prepareFullStackRtcProduction,
    readFullStackRtcProductionSeal
} from './playwright-full-stack-spa-server.ts';

const fullStackEnabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
    process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';
const fullStackApiBaseUrl = readFullStackApiBaseUrl();
const fullStackSpaBaseUrl = readFullStackSpaBaseUrl();
const headlessSpaEnabled = process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS === '1';
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
const captureSetupTiming = process.env.RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING === 'true';
if (
    captureSetupTiming && (!fullStackEnabled || !headlessSpaEnabled || fullStackApiServerMode !== 'memory' ||
        !process.env.RALLAR_BLACK_BOX_STORAGE_DIR)
) {
    throw new Error('Setup timing capture requires the all-local memory/headless lifecycle and recorder directory.');
}
const timingCaptureDirectory = captureSetupTiming ? process.env.RALLAR_BLACK_BOX_STORAGE_DIR : undefined;
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

const productionConfiguration = {
    buildRoot: process.env.RALLAR_BLACK_BOX_RTC_BUILD_ROOT ?? '',
    apiBaseUrl: fullStackApiBaseUrl,
    spaBaseUrl: fullStackSpaBaseUrl,
    environment: process.env
};
const preparedProduction = admittedRtcAttempt?.locator.environmentId === 'E3-memory'
    ? process.env.RALLAR_BLACK_BOX_RTC_BUILD_SEALED === '1'
        ? await readFullStackRtcProductionSeal(admittedRtcAttempt, productionConfiguration)
        : await prepareFullStackRtcProduction(
            admittedRtcAttempt,
            productionConfiguration,
            createDefaultFullStackRtcProductionDependencies(admittedRtcAttempt.repoRoot)
        )
    : null;
if (preparedProduction?.left) {
    throw new Error(preparedProduction.left.message);
}
if (preparedProduction?.right) {
    process.env.RALLAR_BLACK_BOX_RTC_BUILD_SEALED = '1';
}
const spaWebServer = preparedProduction?.right
    ? createFullStackRtcPreviewServer(preparedProduction.right)
    : {
        command: `cd ../.. && npm --workspace ${
            headlessSpaEnabled ? 'rallar-black-box-headless' : 'rallar-black-box'
        } run dev -- --port ${portFromBaseUrl(fullStackSpaBaseUrl)} --force`,
        env: { VITE_RALLAR_API_BASE_URL: fullStackApiBaseUrl },
        url: headlessSpaEnabled ? `${fullStackSpaBaseUrl}/headless/` : fullStackSpaBaseUrl,
        reuseExistingServer,
        timeout: 60_000
    };

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            createDefaultFullStackApiV1WebServer({
                mode: fullStackApiServerMode,
                apiBaseUrl: fullStackApiBaseUrl,
                spaBaseUrl: fullStackSpaBaseUrl,
                reuseExistingServer,
                requireFreshPostgres: requireFreshPostgresApi,
                timingCaptureDirectory,
                admittedRtcCaseId: admittedRtcAttempt?.locator.caseId ?? null,
                environment: process.env
            }),
            ...(liveRtcClusterEnabled
                ? clusterApiBaseUrls.map((apiBaseUrl) =>
                    createDefaultFullStackApiV1WebServer({
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
    spaWebServer,
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
