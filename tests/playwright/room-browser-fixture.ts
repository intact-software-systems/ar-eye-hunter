import {
    test,
    type Browser,
    type BrowserContextOptions,
    type CDPSession,
    type Page,
    type TestInfo
} from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { arch, availableParallelism, platform, totalmem } from 'node:os';
import { BrowserTimingCapture } from '../../packages/shared-test/browser-timing-capture.ts';
import { createDefaultTimers } from '../../packages/shared/resilience/timers.ts';

interface RoomBrowserFixtures {
    readonly guest: Page;
    readonly hostTiming: void;
}

export const roomBrowserTest = test.extend<RoomBrowserFixtures>({
    hostTiming: [async ({ page }, use, testInfo) => {
        const capture = await startPageTiming(page, testInfo, 'host');
        try {
            await use();
        }
        finally {
            await capture?.stop();
        }
    }, { auto: true }],
    guest: async ({ browser }, use, testInfo) => {
        await useIsolatedRoomPage(browser, use, testInfo, 'guest', {});
    }
});

/** Owns one player's independent graphics process, timing capture and exported context trace. */
export async function useIsolatedRoomPage(
    browser: Browser,
    use: (page: Page) => Promise<void>,
    testInfo: TestInfo,
    role: 'guest' | 'third' | 'fourth',
    contextOptions: BrowserContextOptions
): Promise<void> {
    const isolatedBrowser = await browser.browserType().launch();
    try {
        const context = await isolatedBrowser.newContext(contextOptions);
        try {
            const page = await context.newPage();
            const capture = await startPageTiming(page, testInfo, role);
            try {
                await use(page);
            }
            finally {
                await capture?.stop();
            }
        }
        finally {
            await context.close();
        }
    }
    finally {
        await isolatedBrowser.close();
    }
}

async function startPageTiming(
    page: Page,
    testInfo: TestInfo,
    role: 'host' | 'guest' | 'third' | 'fourth'
): Promise<BrowserTimingCapture | undefined> {
    if (process.env.RALLAR_BROWSER_TIMING !== '1') {
        return undefined;
    }
    const browser = page.context().browser();
    if (!browser || browser.browserType().name() !== 'chromium') {
        throw new Error('Browser timing capture requires Chromium');
    }
    let renderer: CDPSession | undefined;
    let browserSession: CDPSession | undefined;
    try {
        renderer = await page.context().newCDPSession(page);
        browserSession = await browser.newBrowserCDPSession();
        const { gpu } = await browserSession.send('SystemInfo.getInfo');
        const artifactPath = testInfo.outputPath(`browser-timing-${role}.jsonl`);
        writeFileSync(
            artifactPath,
            JSON.stringify({
                kind: 'environment',
                startedAtEpochMs: Date.now(),
                role,
                sourceRevision: process.env.RALLAR_ROOM_JOURNEY_REVISION ?? null,
                browserVersion: browser.version(),
                nodeVersion: process.version,
                platform: platform(),
                arch: arch(),
                availableParallelism: availableParallelism(),
                totalMemoryBytes: totalmem(),
                rendererTimeDomain: 'timeTicks',
                sampleIntervalMs: 1000,
                graphics: gpu.devices.map((device) => ({ vendor: device.vendorString, device: device.deviceString })),
                testId: testInfo.testId,
                repeatEachIndex: testInfo.repeatEachIndex,
                retry: testInfo.retry
            }) + '\n'
        );
        const capture = new BrowserTimingCapture({
            renderer,
            browser: browserSession,
            timers: createDefaultTimers(),
            record: (observation) => appendFileSync(artifactPath, JSON.stringify(observation) + '\n')
        });
        await capture.start();
        return capture;
    }
    catch {
        await Promise.allSettled([renderer?.detach(), browserSession?.detach()]);
        throw new Error('Browser timing capture could not initialize');
    }
}
