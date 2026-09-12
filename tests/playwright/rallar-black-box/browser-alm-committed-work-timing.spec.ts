import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    NativeAlmRetryReleaseSemanticsProbe,
    NativeAlmTimingProbe,
    NativeAlmTimingWorkload
} from './browser-alm-committed-work-timing-fixture.ts';
import type {
    NativeIndexedDbTimingDisposalProbe,
    NativeIndexedDbTimingPreCaptureTransactionProbe,
    NativeIndexedDbTimingSemanticsProbe
} from './browser-native-indexeddb-timing-recorder.ts';

const FIXTURE_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-committed-work-timing-fixture.ts'
);
const NATIVE_INDEXED_DB_FIXTURE_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-native-indexeddb-timing-recorder.ts'
);

test('keeps native request outcomes distinct from terminal transaction outcomes', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<NativeIndexedDbTimingSemanticsProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-native-indexeddb-timing-recorder.ts') = await import(moduleUrl);
            return await fixture.runNativeIndexedDbTimingSemanticsProbe(crypto.randomUUID());
        },
        `/@fs${NATIVE_INDEXED_DB_FIXTURE_PATH}`
    );

    expect(result.durableCommittedValue).toBe('committed');
    expect(result.durableAbortedValue).toBeUndefined();
    expect(result.successfulPutInAbortedTransaction).toBe(true);
    expect(result.transactionOutcomes).toEqual(expect.arrayContaining(['complete', 'abort']));
    expect(result.cursorRequestCount).toBe(2);
    expect(result.cursorIterationCount).toBe(2);
    expect(result.totalIssuedRequestCount).toBe(7);
    expect(result.methodsRestored).toBe(true);
    expect(result.sampleCapacity).toBe(3);
    expect(result.droppedSampleCount).toBeGreaterThan(0);
});

test('stops pending native observations without recording after disposal', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<NativeIndexedDbTimingDisposalProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-native-indexeddb-timing-recorder.ts') = await import(moduleUrl);
            return await fixture.runNativeIndexedDbTimingDisposalProbe(crypto.randomUUID());
        },
        `/@fs${NATIVE_INDEXED_DB_FIXTURE_PATH}`
    );

    expect(result.samplesAtStop).toBe(result.samplesAfterCompletion);
    expect(result.uncapturedInFlightObservationCount).toBeGreaterThan(0);
    expect(result.durableValue).toBe('completed-after-stop');
    expect(result.methodsRestored).toBe(true);
});

test('preserves requests issued on transactions opened before capture', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<NativeIndexedDbTimingPreCaptureTransactionProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-native-indexeddb-timing-recorder.ts') = await import(moduleUrl);
            return await fixture.runNativeIndexedDbTimingPreCaptureTransactionProbe(crypto.randomUUID());
        },
        `/@fs${NATIVE_INDEXED_DB_FIXTURE_PATH}`
    );

    expect(result.operationResult).toBe('returned');
    expect(result.operationError).toBeNull();
    expect(result.transactionOutcome).toBe('complete');
    expect(result.durableValue).toBe('persisted');
    expect(result.uncapturedPreCaptureRequestCount).toBe(1);
    expect(result.methodsRestored).toBe(true);
});

test('does not treat a returned retry release as durable completion', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<NativeAlmRetryReleaseSemanticsProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-alm-committed-work-timing-fixture.ts') = await import(moduleUrl);
            return fixture.runNativeAlmRetryReleaseSemanticsProbe();
        },
        `/@fs${FIXTURE_PATH}`
    );

    expect(result.callbackDelivered).toBe(true);
    expect(result.returnedReleasePhaseCaptured).toBe(true);
    expect(result.durableCompletionObserved).toBe(false);
});

test(
    'measures committed-work progress through production admission and QueueBox owners',
    async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        await page.goto('/');
        const results: NativeAlmTimingProbe[] = [];
        for (const workload of ['sparse', 'full-page', 'excess-fanout', 'finite-backlog'] as const) {
            results.push(
                await runWorkload({
                    page,
                    workload,
                    databaseId: `${crypto.randomUUID()}-${workload}`,
                    actorId: workload
                })
            );
        }
        await writeArtifactIfRequested(results, 'replace');

        for (const result of results) {
            expect(result.failure).toBeNull();
            expect(result.nativeTiming.samples.length).toBeGreaterThan(0);
            expect(result.nativeTiming.droppedSampleCount).toBe(0);
            expect(result.nativeTiming.requestSummaries.length).toBeGreaterThan(0);
            expect(result.nativeTiming.transactionSummaries.length).toBeGreaterThan(0);
            expect(result.logicalOperationCounts.total).toBeGreaterThan(0);
            expect(result.operationSummaries.map((summary) => summary.operation)).toEqual(expect.arrayContaining([
                'admission',
                'commit',
                'work-page',
                'reservation',
                'release'
            ]));
            expect(result.throughputPerSecond).toBeGreaterThan(0);
            expect(result.methodsRestored).toBe(true);
            expect(result.durationMs).toBe(result.measurementEndedAtMs - result.measurementStartedAtMs);
            expect(result.nativeTiming.samples.every((sample) =>
                sample.startedAtMs >= result.measurementStartedAtMs &&
                sample.startedAtMs + sample.durationMs <= result.measurementEndedAtMs
            )).toBe(true);
            expect(result.terminalVerification.startedAtMs).toBeGreaterThanOrEqual(result.measurementEndedAtMs);
            expect(result.terminalVerification.logicalOperationCounts.byKind['work-read']).toBeGreaterThan(0);
        }

        const sparse = results.find((result) => result.workload === 'sparse');
        expect(sparse?.deliveredCount).toBe(1);
        expect(sparse?.durableCompletedIdentityCount).toBe(1);
        expect(sparse?.durableCompletedIdentities).toEqual(['sparse']);
        const fullPage = results.find((result) => result.workload === 'full-page');
        expect(fullPage?.deliveredCount).toBe(16);
        expect(fullPage?.completeCausalIdentityCount).toBe(16);
        expect(fullPage?.durableCompletedIdentityCount).toBe(16);
        expect(fullPage?.durableCompletedIdentities).toEqual(numberedNativeAlmIdentities('parent', 16));
        expect(
            fullPage?.causalSamples.filter((sample) =>
                ['effects-committed', 'parent-released', 'callback-start', 'callback-end', 'effect-released'].includes(
                    sample.phase
                ) && sample.leaseMarginMs === null
            )
        ).toEqual([]);
        const fanout = results.find((result) => result.workload === 'excess-fanout');
        expect(fanout?.deliveredCount).toBe(13);
        expect(fanout?.completeCausalIdentityCount).toBe(13);
        expect(fanout?.durableCompletedIdentityCount).toBe(13);
        expect(fanout?.durableCompletedIdentities).toEqual(numberedNativeAlmIdentities('parent', 13));
        expect(fanout?.maximumSuccessorsBeyondRemainingPageCapacity).toBeGreaterThan(0);
        const backlog = results.find((result) => result.workload === 'finite-backlog');
        expect(backlog?.recoveredKinds).toEqual(expect.arrayContaining(['new', 'retry', 'expired-reserved']));
        expect(backlog?.oldestEligibleAgeMs).toBeGreaterThanOrEqual(900);
        expect(
            backlog?.causalSamples.find((sample) =>
                sample.identity === 'eligible-retry' && sample.phase === 'successor-reserved'
            )?.queueAgeMs
        ).toBeGreaterThanOrEqual(900);
        expect(
            backlog?.causalSamples.find((sample) =>
                sample.identity === 'eligible-expired-reserved' && sample.phase === 'successor-reserved'
            )?.queueAgeMs
        ).toBeGreaterThanOrEqual(900);
        expect(backlog?.boundedCommitCount).toBeGreaterThan(0);
        expect(backlog?.durableCompletedIdentityCount).toBe(11);
        expect(backlog?.durableCompletedIdentities).toEqual([
            'eligible-expired-reserved',
            'eligible-new',
            'eligible-retry',
            ...numberedNativeAlmIdentities('producer', 8)
        ]);
        expect(backlog?.waitingEntryCount).toBe(32);

        await testInfo.attach('native-alm-timing.json', {
            body: JSON.stringify(toNativeAlmTimingArtifact(results), null, 2),
            contentType: 'application/json'
        });
    }
);

function numberedNativeAlmIdentities(prefix: 'parent' | 'producer', count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

test('two same-origin tabs share durable contention without inventing effect commits', async ({ context, page }) => {
    test.setTimeout(60_000);
    const otherPage = await context.newPage();
    await Promise.all([page.goto('/'), otherPage.goto('/')]);
    const databaseId = crypto.randomUUID();
    const [first, second] = await Promise.all([
        runWorkload({ page, workload: 'shared-contention', databaseId, actorId: 'first' }),
        runWorkload({ page: otherPage, workload: 'shared-contention', databaseId, actorId: 'second' })
    ]);
    await writeArtifactIfRequested([first, second], 'append');

    expect(first.failure).toBeNull();
    expect(second.failure).toBeNull();
    expect(first.deliveredCount + second.deliveredCount).toBe(1);
    expect(first.observedCommittedEffectIdentityCount + second.observedCommittedEffectIdentityCount).toBe(1);
    expect(first.commitConflictCount + second.commitConflictCount).toBeGreaterThan(0);
    expect(first.durableCompletedIdentityCount).toBe(1);
    expect(second.durableCompletedIdentityCount).toBe(1);
    expect(first.methodsRestored && second.methodsRestored).toBe(true);
});

async function runWorkload(
    input: Readonly<{
        page: import('@playwright/test').Page;
        workload: NativeAlmTimingWorkload;
        databaseId: string;
        actorId: string;
    }>
): Promise<NativeAlmTimingProbe> {
    return await input.page.evaluate<NativeAlmTimingProbe, {
        readonly moduleUrl: string;
        readonly workload: NativeAlmTimingWorkload;
        readonly databaseId: string;
        readonly actorId: string;
    }>(
        async (input) => {
            const fixture: typeof import('./browser-alm-committed-work-timing-fixture.ts') = await import(
                input.moduleUrl
            );
            return await fixture.runNativeAlmTimingProbe(input);
        },
        {
            moduleUrl: `/@fs${FIXTURE_PATH}`,
            workload: input.workload,
            databaseId: input.databaseId,
            actorId: input.actorId
        }
    );
}

async function writeArtifactIfRequested(
    results: readonly NativeAlmTimingProbe[],
    mode: 'replace' | 'append'
): Promise<void> {
    const outputPath = process.env.RALLAR_ALM_NATIVE_TIMING_OUT?.trim();
    if (!outputPath) {
        return;
    }
    const retained = mode === 'append' ? await readRetainedResults(outputPath) : [];
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
        outputPath,
        `${JSON.stringify(toNativeAlmTimingArtifact([...retained, ...results]), null, 2)}\n`,
        'utf8'
    );
}

interface RetainedNativeAlmTimingArtifact {
    readonly schema?: string;
    readonly results?: readonly NativeAlmTimingProbe[];
}

async function readRetainedResults(outputPath: string): Promise<readonly NativeAlmTimingProbe[]> {
    try {
        const artifact: RetainedNativeAlmTimingArtifact = JSON.parse(await readFile(outputPath, 'utf8'));
        if (artifact.schema !== 'rallar.native-alm-committed-work-timing.v1') {
            return [];
        }
        return Array.isArray(artifact.results) ? artifact.results : [];
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function toNativeAlmTimingArtifact(results: readonly NativeAlmTimingProbe[]) {
    return {
        schema: 'rallar.native-alm-committed-work-timing.v1',
        runtimeBaseCommit: process.env.RALLAR_ALM_NATIVE_TIMING_SOURCE ?? 'working-tree',
        measurementCodeRevision: process.env.RALLAR_ALM_NATIVE_TIMING_INSTRUMENTATION_SOURCE ?? 'working-tree',
        measuredTree: 'runtime-base-plus-measurement-instrumentation',
        hostEnvironment: {
            nodeVersion: process.version,
            platform: process.platform,
            architecture: process.arch
        },
        results
    };
}
