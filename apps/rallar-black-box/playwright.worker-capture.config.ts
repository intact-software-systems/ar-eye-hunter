import { defineConfig } from '@playwright/test';

import { createFullStackApiV1WebServer } from './playwright-full-stack-api-server.ts';
import { createFullStackControlWebServer } from './playwright-full-stack-control-server.ts';

const apiBaseUrl = 'http://127.0.0.1:8080';
const headlessBaseUrl = 'http://127.0.0.1:5179';
const controlBaseUrl = 'http://127.0.0.1:5180';

export default defineConfig({
    testDir: '../../tests/playwright/rallar-black-box',
    testMatch: 'full-stack-worker-host-capture.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 180_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
    webServer: [
        createFullStackApiV1WebServer({
            mode: 'postgres',
            apiBaseUrl,
            spaBaseUrl: headlessBaseUrl,
            reuseExistingServer: false,
            requireFreshPostgres: true
        }),
        {
            command: 'cd ../.. && npm --workspace rallar-black-box-headless run dev',
            env: { VITE_RALLAR_API_BASE_URL: apiBaseUrl },
            url: `${headlessBaseUrl}/headless/`,
            reuseExistingServer: false,
            timeout: 60_000
        },
        createFullStackControlWebServer({ baseUrl: controlBaseUrl, reuseExistingServer: false })
    ]
});
