import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const fullStackEnabled = process.env.RALLAR_ARENA_FULL_STACK === '1';
const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
    ...(fullStackEnabled
        ? [{
            command: 'cd ../api-v1 && deno task start:memory',
            env: {
                PORT: '8080',
                CORS_ORIGINS: 'http://127.0.0.1:5186,http://localhost:5186',
                RALLAR_API_BASE_URL: 'http://127.0.0.1:8080',
                RALLAR_WS_BASE_URL: 'ws://127.0.0.1:8080',
                RALLAR_AUTH_CREDENTIAL_SECRET: randomUUID(),
                RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: randomUUID(),
                RALLAR_LOGIN_USER_RATE_LIMIT: '100',
                RALLAR_TIMING_LOGS: 'false'
            },
            url: 'http://127.0.0.1:8080/api/config',
            reuseExistingServer: false,
            timeout: 120_000
        }]
        : []),
    {
        command: fullStackEnabled
            ? 'npm run build && npm run preview -- --host 127.0.0.1 --port 5186 --strictPort'
            : 'npm run dev -- --host 127.0.0.1 --port 5186',
        env: { API_BASE_URL: 'http://127.0.0.1:8080' },
        url: 'http://127.0.0.1:5186',
        reuseExistingServer: !fullStackEnabled && !process.env.CI,
        timeout: fullStackEnabled ? 120_000 : 60_000
    }
];

export default defineConfig({
    testDir: '../../tests/playwright/ar-eye-hunter',
    // Multi-browser functional journeys include software-rendered arenas on hosted runners.
    timeout: fullStackEnabled ? 120_000 : 45_000,
    expect: {
        timeout: fullStackEnabled ? 15_000 : 8_000
    },
    fullyParallel: false,
    workers: fullStackEnabled ? 1 : undefined,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5186',
        trace: fullStackEnabled
            ? { mode: 'retain-on-failure', screenshots: false, snapshots: true }
            : 'on-first-retry',
        screenshot: 'only-on-failure'
    },
    webServer,
    projects: [
        {
            name: 'desktop-delivery',
            testMatch: [
                '**/director-capability-delivery.spec.ts',
                '**/open-arena-directory.spec.ts',
                '**/private-room-entry.spec.ts',
                '**/quick-join.spec.ts'
            ],
            use: {
                ...devices['Desktop Chrome'],
                browserName: 'chromium',
                launchOptions: fullStackEnabled
                    ? {
                        args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
                    }
                    : undefined
            }
        },
        {
            name: 'iphone-landscape',
            testMatch: '**/mobile-controls.spec.ts',
            use: {
                ...devices['iPhone 14 Pro landscape'],
                browserName: 'chromium'
            }
        },
        {
            name: 'ipad-landscape',
            testMatch: '**/mobile-controls.spec.ts',
            use: {
                ...devices['iPad Pro 11 landscape'],
                browserName: 'chromium'
            }
        },
        {
            name: 'iphone-portrait',
            testMatch: '**/mobile-controls.spec.ts',
            use: {
                ...devices['iPhone 14 Pro'],
                browserName: 'chromium'
            }
        }
    ]
});
