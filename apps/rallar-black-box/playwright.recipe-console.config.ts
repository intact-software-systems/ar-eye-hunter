import { defineConfig, devices } from '@playwright/test';

const RECIPE_CONSOLE_TEST_ENV = {
    VITE_RALLAR_API_BASE_URL: 'http://localhost:8080',
};

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: /recipe-console-.*\.spec\.ts/,
    timeout: 30_000,
    expect: {
        timeout: 10_000,
        toHaveScreenshot: {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.01,
            scale: 'css',
        },
    },
    use: {
        baseURL: 'http://127.0.0.1:5176',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: [
        {
            command: 'npm run dev -- --host 127.0.0.1 --port 5176',
            cwd: '.',
            url: 'http://127.0.0.1:5176',
            reuseExistingServer: false,
            env: RECIPE_CONSOLE_TEST_ENV,
        },
        {
            command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4176 --strictPort',
            cwd: '.',
            url: 'http://127.0.0.1:4176',
            reuseExistingServer: false,
            timeout: 120_000,
            env: RECIPE_CONSOLE_TEST_ENV,
        },
    ],
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                colorScheme: 'light',
                deviceScaleFactor: 1,
                locale: 'en-US',
                timezoneId: 'UTC',
            },
        },
    ],
});
