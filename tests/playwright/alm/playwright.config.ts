import { defineConfig } from '@playwright/test';

/** A manual measurement suite: one worker, so no other page competes for the CPU it measures. */
export default defineConfig({
    testDir: '.',
    testMatch: /durable-send-plain-page\.spec\.ts/,
    timeout: 20 * 60_000,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    reporter: [['list']]
});
