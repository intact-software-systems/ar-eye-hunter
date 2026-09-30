import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
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
import {
    DURABLE_SEND_HARNESS_SCRIPT_URL,
    profileDurableSends,
    readBrowserVersion,
    routeDurableSendHarness,
    runDurableSendConfiguration,
    type DurableSendConfiguration
} from './drive-durable-send-harness.ts';
import {
    toConfigurationFigures,
    toDurableSendTable,
    writeDurableSendReport,
    type DurableSendConfigurationFigures,
    type DurableSendMethod
} from './durable-send-report.ts';
import { DURABLE_SEND_OWN_PROBE_CAUSES } from './harness/durable-send-harness-contract.ts';

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

async function measureConfiguration(
    context: BrowserContext,
    configuration: DurableSendConfiguration
): Promise<DurableSendConfigurationFigures> {
    const runs = [];
    for (let run = 0; run < METHOD.runCount; run += 1) {
        runs.push(
            await runDurableSendConfiguration(context, configuration, {
                runId: `${configuration.name}-${run}`,
                warmupCount: METHOD.warmupCount,
                measuredCount: METHOD.measuredCount
            })
        );
    }
    return toConfigurationFigures(configuration, runs);
}

async function measureProfileShares(
    context: BrowserContext,
    bundle: DurableSendHarnessBundle
): Promise<CpuProfileShares> {
    const profile = await profileDurableSends(context, {
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
}

test('a durable send on a plain page with an on-disk profile reports send-to-dispatch and CPU shares', async () => {
    const bundle = await bundleDurableSendHarness();
    const profileDirectory = await mkdtemp(join(tmpdir(), 'alm-durable-send-'));
    const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
    try {
        await routeDurableSendHarness(context, bundle.script);
        const configurations = [];
        for (const configuration of CONFIGURATIONS) {
            configurations.push(await measureConfiguration(context, configuration));
        }
        const report = {
            createdAt: new Date().toISOString(),
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
            browser: await readBrowserVersion(context),
            host: `${platform()} ${arch()} ${cpus()[0]?.model ?? 'unknown cpu'}`,
            method: METHOD,
            configurations,
            profile: await measureProfileShares(context, bundle)
        };
        console.log(
            `${toDurableSendTable(report)}\nartifact: ${await writeDurableSendReport(report)}`
        );
        // Evidence, not a gate: the suite fails only when a run lost figures, a send started before
        // its predecessor's own batch was idle again (a wait ends only on a probe that send earned), or the profile could not attribute its samples,
        // never on a latency value.
        for (const configuration of configurations) {
            expect(
                configuration.runs.map((run) => [run.sendToDispatchMs.length, run.unsettledCount]),
                `${configuration.name}: every measured send was dispatched and its batch went idle`
            )
                .toEqual(Array(METHOD.runCount).fill([METHOD.measuredCount, 0]));
            expect(
                configuration.runs.flatMap((run) => Object.keys(run.probeCauses))
                    .filter((cause) => !DURABLE_SEND_OWN_PROBE_CAUSES.includes(cause as never)),
                `${configuration.name}: every wait ended on a probe its own send earned`
            ).toEqual([]);
        }
        expectProfileAttribution(bundle, report.profile);
    }
    finally {
        await context.close();
        await rm(profileDirectory, { recursive: true, force: true });
    }
});
