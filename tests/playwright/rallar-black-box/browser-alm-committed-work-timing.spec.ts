import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    NativeAlmTimingProbe,
    NativeAlmTimingWorkload,
    NativeIndexedDbTimingSemanticsProbe
} from './browser-alm-committed-work-timing-fixture.ts';

const FIXTURE_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-committed-work-timing-fixture.ts'
);

test('keeps native request outcomes distinct from terminal transaction outcomes', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<NativeIndexedDbTimingSemanticsProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-alm-committed-work-timing-fixture.ts') = await import(moduleUrl);
            return await fixture.runNativeIndexedDbTimingSemanticsProbe(crypto.randomUUID());
        },
        `/@fs${FIXTURE_PATH}`
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
        }

        expect(results.find((result) => result.workload === 'sparse')?.deliveredCount).toBe(1);
        const fullPage = results.find((result) => result.workload === 'full-page');
        expect(fullPage?.deliveredCount).toBe(16);
        expect(fullPage?.completeCausalIdentityCount).toBeGreaterThan(0);
        expect(fullPage?.causalCoverage.some((coverage) => coverage.uncapturedPhases.length === 0)).toBe(true);
        const fanout = results.find((result) => result.workload === 'excess-fanout');
        expect(fanout?.deliveredCount).toBe(13);
        expect(fanout?.completeCausalIdentityCount).toBe(13);
        expect(fanout?.maximumSuccessorsBeyondRemainingPageCapacity).toBeGreaterThan(0);
        const backlog = results.find((result) => result.workload === 'finite-backlog');
        expect(backlog?.recoveredKinds).toEqual(expect.arrayContaining(['new', 'retry', 'expired-reserved']));
        expect(backlog?.boundedCommitCount).toBeGreaterThan(0);
        expect(backlog?.waitingEntryCount).toBeGreaterThan(0);

        await testInfo.attach('native-alm-timing.json', {
            body: JSON.stringify(toNativeAlmTimingArtifact(results), null, 2),
            contentType: 'application/json'
        });
    }
);

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

async function readRetainedResults(outputPath: string): Promise<readonly NativeAlmTimingProbe[]> {
    try {
        const artifact = JSON.parse(await readFile(outputPath, 'utf8')) as { readonly results?: unknown; };
        return Array.isArray(artifact.results) ? artifact.results as NativeAlmTimingProbe[] : [];
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
