import { defineConfig, devices } from '@playwright/test';

import { RALLAR_BLACK_BOX_EXPECT_TIMEOUT_MS } from '../../packages/shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';

const reuseExistingServer = !process.env.CI;

/** A test's limit when it sets none of its own. */
const RALLAR_BLACK_BOX_TEST_TIMEOUT_MS = 30_000;

/** How long Playwright waits for the SPA's dev server, then for the control server, to answer. */
const RALLAR_BLACK_BOX_WEB_SERVER_START_TIMEOUT_MS = 60_000;

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testIgnore: /recipe-console-.*\.spec\.ts/,
    timeout: RALLAR_BLACK_BOX_TEST_TIMEOUT_MS,
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
            timeout: RALLAR_BLACK_BOX_WEB_SERVER_START_TIMEOUT_MS
        },
        {
            command: 'cd ../rallar-black-box-control-server && bun run src/main.ts',
            url: 'http://127.0.0.1:5180/health',
            reuseExistingServer,
            timeout: RALLAR_BLACK_BOX_WEB_SERVER_START_TIMEOUT_MS
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
