import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    bundleDurableSendHarness,
    type DurableSendHarnessBundle
} from './bundle-durable-send-harness.ts';
import {
    CODEC_SOURCE_SUFFIX,
    computeCpuProfileShares,
    JSBI_SOURCE,
    TEMPORAL_POLYFILL_SOURCE,
    type CpuProfileShares
} from './compute-cpu-profile-shares.ts';
import { computePercentile } from './compute-send-to-dispatch-percentiles.ts';
import {
    toConfigurationFigures,
    toDurableSendTable,
    writeDurableSendReport,
    type DurableSendConfigurationFigures,
    type DurableSendMethod
} from './durable-send-report.ts';
import {
    DURABLE_SEND_PLAN_BATCH_ENDS,
    DURABLE_SEND_PLANS,
    type DurableSendPlan,
    type DurableSendReceiptEnd
} from './harness/durable-send-harness-contract.ts';
import {
    DURABLE_SEND_HARNESS_SCRIPT_URL,
    profileDurableSends,
    readBrowserVersion,
    routeDurableSendHarness,
    runDurableSendConfiguration,
    type DurableSendConfiguration
} from './run-durable-send-configuration.ts';

const METHOD: DurableSendMethod = {
    warmupCount: 10,
    measuredCount: 90,
    runCount: 3,
    profiledCount: 300
};

const CONFIGURATIONS: readonly DurableSendConfiguration[] = [
    { name: 'idle', cpuThrottlingRate: 1, frameLoad: undefined },
    { name: 'cpu-4x', cpuThrottlingRate: 4, frameLoad: undefined },
    {
        name: 'frame-load',
        cpuThrottlingRate: 1,
        frameLoad: { busyMsPerFrame: 10, frameIntervalMs: 16 }
    },
    {
        name: 'cpu-4x-frame-load',
        cpuThrottlingRate: 4,
        frameLoad: { busyMsPerFrame: 10, frameIntervalMs: 16 }
    }
];

/** How each plan's receipt ends; where its batch goes idle is the page's own table. */
const PLAN_RECEIPT_ENDS: Readonly<Record<DurableSendPlan, DurableSendReceiptEnd>> = {
    minimal: 'none',
    'receipted-command': 'acknowledged'
};

function computeCountSum(counts: Readonly<Record<string, number>>): number {
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

async function measureConfiguration(
    context: BrowserContext,
    configuration: DurableSendConfiguration,
    plan: DurableSendPlan
): Promise<DurableSendConfigurationFigures> {
    const runs = [];
    for (let run = 0; run < METHOD.runCount; run += 1) {
        runs.push(
            await runDurableSendConfiguration(context, configuration, {
                plan,
                runId: `${configuration.name}-${plan}-${run}`,
                warmupCount: METHOD.warmupCount,
                measuredCount: METHOD.measuredCount
            })
        );
    }
    return toConfigurationFigures(configuration, plan, runs);
}

async function measureProfileShares(
    context: BrowserContext,
    bundle: DurableSendHarnessBundle
): Promise<CpuProfileShares> {
    // The minimal plan only, so the attribution compares with the profiles of earlier heads.
    const profile = await profileDurableSends(context, {
        plan: 'minimal',
        runId: 'profile',
        warmupCount: METHOD.warmupCount,
        measuredCount: METHOD.profiledCount
    });
    return computeCpuProfileShares({
        profile,
        bundleUrl: DURABLE_SEND_HARNESS_SCRIPT_URL,
        modules: bundle.modules
    });
}

function expectProfileAttribution(
    bundle: DurableSendHarnessBundle,
    profile: CpuProfileShares
): void {
    const sources = bundle.modules.map((module) => module.source);
    expect(
        sources.some((source) => source.includes(TEMPORAL_POLYFILL_SOURCE)),
        'the bundle lists a @js-temporal/polyfill module'
    ).toBe(true);
    expect(
        sources.some((source) => source.includes(JSBI_SOURCE)),
        'the bundle lists a jsbi module'
    ).toBe(true);
    expect(
        sources.some((source) => source.endsWith(CODEC_SOURCE_SUFFIX)),
        'the bundle lists the IndexedDB queue-box entry codec module'
    ).toBe(true);
    expect(profile.busyMs, 'the profile holds busy samples').toBeGreaterThan(0);
    expect(profile.otherPercent, 'the profile attributes some busy time to a named owner')
        .toBeLessThan(100);
    // Each read row still parses once, so a zero share means mis-attribution, not a saving.
    expect(profile.temporalPolyfillPercent, 'some busy time is in the polyfill').toBeGreaterThan(0);
    expect(profile.jsbiPercent, 'some busy time is in JSBI').toBeGreaterThan(0);
    expect(profile.codecInclusivePercent, 'some busy time has the codec on the stack').toBeGreaterThan(0);
}

function expectRunsSettled(configurations: readonly DurableSendConfigurationFigures[]): void {
    // Evidence, not a gate: the suite fails only when a run lost figures, a send started before the
    // batch of the send before it was idle again (a wait ends only on the drain of the batch that sent,
    // or on the probe after it), a wait saw a probe its plan does not end on, a receipt stayed open, or
    // the profile could not attribute its samples; never on a latency value.
    for (const configuration of configurations) {
        const label = `${configuration.name} ${configuration.plan}`;
        expect(
            configuration.runs.map((run) => [run.sendToDispatchMs.length, run.unsettledCount]),
            `${label}: every measured send was dispatched and its batch went idle`
        )
            .toEqual(Array(METHOD.runCount).fill([METHOD.measuredCount, 0]));
        const batchEnd = DURABLE_SEND_PLAN_BATCH_ENDS[configuration.plan];
        expect(
            configuration.runs.map((run) => run.batchEnds),
            `${label}: every wait ended where the batch of its plan goes idle`
        ).toEqual(Array(METHOD.runCount).fill({ [batchEnd]: METHOD.measuredCount }));
        expect(
            configuration.runs.map((run) => computeCountSum(run.observedProbeCauses)),
            `${label}: a wait saw only the probe it ended on`
        ).toEqual(Array(METHOD.runCount).fill(batchEnd === 'readiness-probe' ? METHOD.measuredCount : 0));
        expect(
            configuration.runs.map((run) => run.receiptEnds),
            `${label}: every receipt ended as its plan expects`
        ).toEqual(Array(METHOD.runCount).fill({ [PLAN_RECEIPT_ENDS[configuration.plan]]: METHOD.measuredCount }));
    }
}

test('a durable send on a plain page with an on-disk profile reports send-to-dispatch and CPU shares', async () => {
    const loadAverageAtStart = loadavg();
    const bundle = await bundleDurableSendHarness();
    const profileDirectory = await mkdtemp(join(tmpdir(), 'alm-durable-send-'));
    const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
    try {
        await routeDurableSendHarness(context, bundle.script);
        const configurations = [];
        for (const configuration of CONFIGURATIONS) {
            for (const plan of DURABLE_SEND_PLANS) {
                configurations.push(await measureConfiguration(context, configuration, plan));
            }
        }
        const report = {
            createdAt: new Date().toISOString(),
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
            browser: await readBrowserVersion(context),
            host: `${platform()} ${arch()} ${cpus()[0]?.model ?? 'unknown cpu'}`,
            method: METHOD,
            configurations,
            profile: await measureProfileShares(context, bundle),
            loadAverage: { atStart: loadAverageAtStart, atEnd: loadavg() }
        };
        console.log(
            `${toDurableSendTable(report)}\nartifact: ${await writeDurableSendReport(report)}`
        );
        expectRunsSettled(configurations);
        expectProfileAttribution(bundle, report.profile);
    }
    finally {
        await context.close();
        await rm(profileDirectory, { recursive: true, force: true });
    }
});

test('the profile and percentile arithmetic the report rests on', () => {
    const bundleUrl = 'http://localhost/harness.js';
    const modules = [
        { startLine: 0, source: 'node_modules/@js-temporal/polyfill/lib/index.mjs' },
        { startLine: 10, source: 'node_modules/jsbi/dist/jsbi.mjs' },
        { startLine: 20, source: 'packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts' },
        { startLine: 30, source: 'packages/shared/alm/other.ts' }
    ];
    const frame = (functionName: string, lineNumber: number, url = bundleUrl) => ({ functionName, url, lineNumber });
    // A tree root > codec (line 25) > polyfill (line 5) and root > jsbi (line 15), plus idle.
    const profile = {
        nodes: [
            { id: 1, callFrame: frame('(root)', 0, ''), children: [2, 4, 5] },
            { id: 2, callFrame: frame('decode', 25), children: [3] },
            { id: 3, callFrame: frame('from', 5) },
            { id: 4, callFrame: frame('add', 15) },
            { id: 5, callFrame: frame('(idle)', 0, '') }
        ],
        samples: [2, 3, 4, 5],
        // Each sample's duration is the next delta (0-based), so the first delta is never counted.
        timeDeltas: [999, 1_000, 2_000, 3_000, 4_000]
    };

    expect(computeCpuProfileShares({ profile, bundleUrl, modules })).toEqual({
        busyMs: 6,
        temporalPolyfillPercent: 33.3,
        jsbiPercent: 50,
        temporalPercent: 83.3,
        codecSelfPercent: 16.7,
        codecInclusivePercent: 50,
        temporalUnderCodecPercent: 40,
        otherPercent: 0
    });
    expect(computePercentile([5, 1, 4, 2, 3], 0.5, 10), 'nearest rank: the third of five').toBe(3);
    expect(computePercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95, 10)).toBe(10);
    expect(computePercentile([1.234], 0.5, 100), 'rounded to the scale').toBe(1.23);
});
