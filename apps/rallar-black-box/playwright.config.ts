import { defineConfig, devices } from '@playwright/test';

import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '../../packages/shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

const reuseExistingServer = !process.env.CI;

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testIgnore: /recipe-console-.*\.spec\.ts/,
    timeout: 30_000,
    expect: {
        timeout: RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS
    },
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5176',
        trace: 'on-first-retry'
    },
    webServer: [
        {
            command: 'npm --workspace rallar-black-box run dev -- --host 127.0.0.1 --port 5176',
            url: 'http://127.0.0.1:5176',
            reuseExistingServer,
            timeout: 60_000
        },
        {
            command: 'cd ../rallar-black-box-control-server && bun run src/main.ts',
            url: 'http://127.0.0.1:5180/health',
            reuseExistingServer,
            timeout: 60_000
        }
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
                        '--use-angle=swiftshader'
                    ]
                }
            }
        }
    ]
});
