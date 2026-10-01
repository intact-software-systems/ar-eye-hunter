import type { BrowserContext, CDPSession, Page } from '@playwright/test';

import type { CpuProfile } from './compute-cpu-profile-shares.ts';
import {
    DURABLE_SEND_HARNESS_GLOBAL,
    DURABLE_SEND_PLAN_PARAMETER,
    type DurableSendHarness,
    type DurableSendPlan,
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

/** A run on a fresh page that composes one runtime for the plan it names. */
export interface DurableSendPageRunInput extends Omit<DurableSendRunInput, 'frameLoad'> {
    readonly plan: DurableSendPlan;
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
    const { page, cdp } = await openHarnessPage(context, 'minimal');
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
    input: DurableSendPageRunInput
): Promise<DurableSendRun> {
    const { plan, ...runInput } = input;
    const harnessPage = await openHarnessPage(context, plan);
    try {
        await harnessPage.cdp.send('Emulation.setCPUThrottlingRate', {
            rate: configuration.cpuThrottlingRate
        });
        return await runSendsInPage(harnessPage.page, {
            ...runInput,
            frameLoad: configuration.frameLoad
        });
    }
    finally {
        await closeHarnessPage(harnessPage);
    }
}

export async function profileDurableSends(
    context: BrowserContext,
    input: DurableSendPageRunInput
): Promise<CpuProfile> {
    const { plan, ...runInput } = input;
    const harnessPage = await openHarnessPage(context, plan);
    const idle = { ...runInput, frameLoad: undefined };
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

async function openHarnessPage(context: BrowserContext, plan: DurableSendPlan): Promise<HarnessPage> {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(`${HARNESS_PAGE_URL}?${new URLSearchParams({ [DURABLE_SEND_PLAN_PARAMETER]: plan })}`);
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
