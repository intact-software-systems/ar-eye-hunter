import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '../../tests/playwright/ar-eye-hunter',
    timeout: 45_000,
    expect: {
        timeout: 8_000
    },
    fullyParallel: false,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:5186',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command:
            'cd ../.. && API_BASE_URL=http://127.0.0.1:8080 npm --workspace ar-eye-hunter-v1 run dev -- --host 127.0.0.1 --port 5186',
        url: 'http://127.0.0.1:5186',
        reuseExistingServer: true,
        timeout: 60_000
    },
    projects: [
        {
            name: 'iphone-landscape',
            use: {
                ...devices['iPhone 14 Pro landscape'],
                browserName: 'chromium'
            }
        },
        {
            name: 'ipad-landscape',
            use: {
                ...devices['iPad Pro 11 landscape'],
                browserName: 'chromium'
            }
        },
        {
            name: 'iphone-portrait',
            use: {
                ...devices['iPhone 14 Pro'],
                browserName: 'chromium'
            }
        }
    ]
});
