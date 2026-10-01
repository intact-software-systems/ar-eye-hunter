import type { BrowserContext, CDPSession, Page } from '@playwright/test';

import type { CpuProfile } from './compute-cpu-profile-shares.ts';
import {
    DURABLE_SEND_HARNESS_GLOBAL,
    type DurableSendHarness,
    type DurableSendRun,
    type DurableSendRunInput,
    type FrameLoadInput
} from './harness/durable-send-harness-contract.ts';

/** A secure-context origin, so Web Locks and `crypto.randomUUID` exist; the route serves it, nothing listens. */
const HARNESS_PAGE_URL = 'http://localhost/alm-durable-send/';
export const DURABLE_SEND_HARNESS_SCRIPT_URL = `${HARNESS_PAGE_URL}durable-send-harness.js`;
const HARNESS_PAGE_HTML = '<!doctype html><meta charset="utf-8"><title>ALM durable send</title>' +
    `<script type="module" src="${DURABLE_SEND_HARNESS_SCRIPT_URL}"></script>`;
const PROFILER_SAMPLING_INTERVAL_US = 100;

export interface DurableSendConfiguration {
    readonly name: string;
    readonly cpuThrottlingRate: number;
    readonly frameLoad: FrameLoadInput | undefined;
}

interface HarnessPage {
    readonly page: Page;
    readonly cdp: CDPSession;
}

export async function routeDurableSendHarness(
    context: BrowserContext,
    script: string
): Promise<void> {
    await context.route(`${HARNESS_PAGE_URL}**`, async (route) => {
        const isScript = route.request().url() === DURABLE_SEND_HARNESS_SCRIPT_URL;
        await route.fulfill(
            isScript
                ? { contentType: 'text/javascript', body: script }
                : { contentType: 'text/html', body: HARNESS_PAGE_HTML }
        );
    });
}

export async function readBrowserVersion(context: BrowserContext): Promise<string> {
    const { page, cdp } = await openHarnessPage(context);
    try {
        return (await cdp.send('Browser.getVersion')).product;
    }
    finally {
        await closeHarnessPage({ page, cdp });
    }
}

export async function runDurableSendConfiguration(
    context: BrowserContext,
    configuration: DurableSendConfiguration,
    input: Omit<DurableSendRunInput, 'frameLoad'>
): Promise<DurableSendRun> {
    const harnessPage = await openHarnessPage(context);
    try {
        await harnessPage.cdp.send('Emulation.setCPUThrottlingRate', {
            rate: configuration.cpuThrottlingRate
        });
        return await runSendsInPage(harnessPage.page, {
            ...input,
            frameLoad: configuration.frameLoad
        });
    }
    finally {
        await closeHarnessPage(harnessPage);
    }
}

export async function profileDurableSends(
    context: BrowserContext,
    input: Omit<DurableSendRunInput, 'frameLoad'>
): Promise<CpuProfile> {
    const harnessPage = await openHarnessPage(context);
    const idle = { ...input, frameLoad: undefined };
    try {
        await runSendsInPage(harnessPage.page, { ...idle, measuredCount: 0 });
        await harnessPage.cdp.send('Profiler.enable');
        await harnessPage.cdp.send('Profiler.setSamplingInterval', {
            interval: PROFILER_SAMPLING_INTERVAL_US
        });
        await harnessPage.cdp.send('Profiler.start');
        await runSendsInPage(harnessPage.page, {
            ...idle,
            runId: `${input.runId}-profiled`,
            warmupCount: 0
        });
        return (await harnessPage.cdp.send('Profiler.stop')).profile;
    }
    finally {
        await closeHarnessPage(harnessPage);
    }
}

async function openHarnessPage(context: BrowserContext): Promise<HarnessPage> {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(HARNESS_PAGE_URL);
    await page.waitForFunction(
        (name) => Reflect.has(globalThis, name),
        DURABLE_SEND_HARNESS_GLOBAL
    );
    return { page, cdp };
}

async function closeHarnessPage(harnessPage: HarnessPage): Promise<void> {
    await harnessPage.cdp.detach();
    await harnessPage.page.close();
}

async function runSendsInPage(page: Page, input: DurableSendRunInput): Promise<DurableSendRun> {
    return await page.evaluate(async ({ name, runInput }) => {
        const harness = Reflect.get(globalThis, name) as DurableSendHarness;
        return await harness.runSends(runInput);
    }, { name: DURABLE_SEND_HARNESS_GLOBAL, runInput: input });
}
