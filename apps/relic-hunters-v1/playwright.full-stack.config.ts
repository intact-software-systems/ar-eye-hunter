import {
    defineConfig,
    devices,
    type PlaywrightTestConfig
} from '@playwright/test';
import { randomUUID } from 'node:crypto';

const fullStackEnabled = process.env.RELIC_HUNTERS_FULL_STACK === '1' ||
    process.env.RELIC_HUNTERS_FULL_STACK === 'true';

// Release spectating journeys use the deployable build; DEV-only diagnostics suites retain Vite iteration.
const builtPreviewEnabled = process.env.RELIC_HUNTERS_BUILT_PREVIEW === '1';

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [
            {
                // The browser reaches both transports through Vite; 8090 is the internal server listen port.
                command:
                    'cd ../relic-hunter-server-v1 && CORS_ORIGINS=http://localhost:5175,http://127.0.0.1:5175 PORT=8090 ' +
                    'RALLAR_API_BASE_URL=http://127.0.0.1:5175 RALLAR_WS_BASE_URL=ws://127.0.0.1:5175 deno task start',
                url: 'http://127.0.0.1:8090/api/config',
                env: {
                    RALLAR_ROOM_OWNED_APP_DATA_BINDINGS_JSON: JSON.stringify([{
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        namespace: 'relic-hunter-v1',
                        storeName: 'relic-hunter-games'
                    }]),
                    RALLAR_AUTH_CREDENTIAL_SECRET: randomUUID(),
                    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: randomUUID(),
                    RALLAR_LOGIN_USER_RATE_LIMIT: '100'
                },
                reuseExistingServer: false,
                timeout: 90_000
            }
        ]
        : []),
    {
        command: builtPreviewEnabled
            ? 'npm run build && npm run preview -- --host 127.0.0.1 --port 5175 --strictPort'
            : 'cd ../.. && API_BASE_URL= npm --workspace relic-hunters-v1 run dev -- --host 127.0.0.1',
        env: { API_BASE_URL: '' },
        url: 'http://127.0.0.1:5175',
        reuseExistingServer: false,
        timeout: builtPreviewEnabled ? 120_000 : 60_000
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
    workers: 1,
    reporter: [
        ['list'],
        ...(fullStackEnabled
            ? [
                ['../../packages/shared-test/room-journey-reporter.ts', {
                    application: 'relic-hunters',
                    environment: 'local-relic-server-vite-chromium',
                    sourceRevision: process.env.RALLAR_ROOM_JOURNEY_REVISION ?? null
                }] as const
            ]
            : [])
    ],
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
