import { Temporal } from '@js-temporal/polyfill';
import { expect, it, onTestFinished } from 'vitest';

import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkOutcome, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT } from '@shared/alm/work/al-work-readiness-memory.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { newWorkEntry, readTestALWorkReadyAtMs, toTestALWorkReadySelection } from './al-work-test-entries.ts';

const AL_TEST_TYPES: ReadonlySet<string> = new Set(['AL_TEST']);
const NOW_MS = 10_000;
const MAX_RUNS = 3;

interface ExpediteHarness {
    readonly handler: ALWorkHandler;
    readonly queue: InMemoryQueueBox;
    readonly port: ALWorkQueuePort;
    /** What a row's claim answers on each run; a row named nowhere completes. */
    readonly answers: Map<string, () => ALWorkOutcome>;
    /** Each row read for an expedited claim and each claim run, in order: `read:<id>` and `run:<id>`. */
    readonly log: string[];
    /** Each claim run as the handler states it to the run: `<id>` with whether it is expedited, and its run number. */
    readonly claimRuns: string[];
    /** Holds the claim of a row until the returned gate opens. */
    hold(effectId: string): () => void;
}

function createExpediteHarness(pageSize: number): ExpediteHarness {
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(NOW_MS));
    const log: string[] = [];
    const claimRuns: string[] = [];
    const gates = new Map<string, Promise<void>>();
    const answers = new Map<string, () => ALWorkOutcome>();
    const queuePort = createALWorkQueuePort({
        queue,
        workTypes: AL_TEST_TYPES,
        leaseMs: 30_000,
        nowMs: () => NOW_MS,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
    const port: ALWorkQueuePort = {
        ...queuePort,
        readEntry: async (key) => {
            log.push(`read:${key.contextId}`);
            return await queuePort.readEntry(key);
        }
    };
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const handler = new ALWorkHandler({
        workerId: 'expedite-worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => NOW_MS },
        pageSize,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: () => readTestALWorkReadyAtMs(queue, AL_TEST_TYPES, NOW_MS),
        selectReady: async (claimable, size) => toTestALWorkReadySelection(await claimable.claim({ maxCount: size, observedEntries: undefined })),
        claimSuccessor: undefined,
        runClaim: async (claim) => {
            log.push(`run:${claim.entry.key.contextId}`);
            const { expedited, run } = handler.getClaimRun(claim);
            claimRuns.push(`${claim.entry.key.contextId}:${expedited ? 'expedited' : 'claimed'}:${run}`);
            await gates.get(claim.entry.key.contextId);
            return answers.get(claim.entry.key.contextId)?.() ?? { status: 'completed' };
        },
        diagnostics: undefined
    });
    onTestFinished(() => handler.dispose());
    return {
        handler,
        queue,
        port,
        answers,
        log,
        claimRuns,
        hold: (effectId) => {
            const gate = Promise.withResolvers<void>();
            gates.set(effectId, gate.promise);
            return () => gate.resolve();
        }
    };
}

/** Retains a row while the batch runs and names it for the batch's next claim, as an owner's commit does. */
async function retainExpedited(harness: ExpediteHarness, effectIds: readonly string[]): Promise<void> {
    const entries = effectIds.map((effectId) => newWorkEntry('AL_TEST', effectId));
    for (const entry of entries) {
        await harness.port.retainIfAbsent(entry);
    }
    harness.handler.expedite(entries.map((entry) => entry.key), MAX_RUNS);
    harness.handler.committed(AL_WORK_UNDESCRIBED_COMMIT);
}

async function startBatchHeldOn(harness: ExpediteHarness, effectId: string): Promise<() => void> {
    const open = harness.hold(effectId);
    await harness.port.retainIfAbsent(newWorkEntry('AL_TEST', effectId));
    harness.handler.committed(AL_WORK_UNDESCRIBED_COMMIT);
    await expect.poll(() => harness.log).toContain(`run:${effectId}`);
    return open;
}

it('reads a re-stated row once and claims it once before the batch\'s next claim', async () => {
    const harness = createExpediteHarness(16);
    const open = await startBatchHeldOn(harness, 'in-flight');

    await retainExpedited(harness, ['parked']);
    await retainExpedited(harness, ['parked']);
    open();

    await expect.poll(() => harness.log).toContain('run:parked');
    await harness.handler.dispose();
    expect(harness.log).toEqual(['run:in-flight', 'read:parked', 'run:parked']);
});

it('reads at most a page of expedited rows before the batch\'s next claim', async () => {
    const harness = createExpediteHarness(2);
    const open = await startBatchHeldOn(harness, 'in-flight');

    await retainExpedited(harness, ['a', 'b', 'c']);
    open();

    await expect.poll(() => harness.log).toHaveLength(7);
    await harness.handler.dispose();
    expect(harness.log).toEqual(['run:in-flight', 'read:a', 'read:b', 'run:a', 'read:c', 'run:c', 'run:b']);
});

it('reads nothing for a row named while no batch runs: the batch its commit starts claims it as a due row', async () => {
    const harness = createExpediteHarness(16);

    await retainExpedited(harness, ['idle']);

    await expect.poll(() => harness.log).toContain('run:idle');
    await harness.handler.dispose();
    expect(harness.log).toEqual(['run:idle']);
});

it('runs a row the batch already holds once, though it was named while that claim ran', async () => {
    const harness = createExpediteHarness(16);
    const open = await startBatchHeldOn(harness, 'taken');

    harness.handler.expedite([newWorkEntry('AL_TEST', 'taken').key], MAX_RUNS);
    open();

    await expect.poll(() => harness.log).toContain('read:taken');
    await harness.handler.dispose();
    expect(harness.log).toEqual(['run:taken', 'read:taken']);
});

it('gives an expedited row that keeps answering retry its runs, then leaves its retry to the batch release', async () => {
    const harness = createExpediteHarness(16);
    harness.answers.set('parked', () => ({ status: 'retry' }));
    const open = await startBatchHeldOn(harness, 'in-flight');

    await retainExpedited(harness, ['parked']);
    open();

    await expect.poll(async () => (await harness.queue.getItem(newWorkEntry('AL_TEST', 'parked').key))?.status)
        .toBe(EntityStatus.RETRY);
    await harness.handler.dispose();
    expect(harness.log).toEqual(['run:in-flight', 'read:parked', 'run:parked', 'run:parked', 'run:parked']);
});

it('states each run of an expedited row to that run: the first run, then each re-run, and a batch claim as claimed', async () => {
    const harness = createExpediteHarness(16);
    harness.answers.set('parked', () => ({ status: 'retry' }));
    const open = await startBatchHeldOn(harness, 'in-flight');

    await retainExpedited(harness, ['parked']);
    open();

    await expect.poll(async () => (await harness.queue.getItem(newWorkEntry('AL_TEST', 'parked').key))?.status)
        .toBe(EntityStatus.RETRY);
    await harness.handler.dispose();
    expect(harness.claimRuns).toEqual(['in-flight:claimed:1', 'parked:expedited:1', 'parked:expedited:2', 'parked:expedited:3']);
});

it('runs an expedited row no more once the handler is disposed', async () => {
    const harness = createExpediteHarness(16);
    const disposals: Promise<void>[] = [];
    harness.answers.set('parked', () => {
        disposals.push(harness.handler.dispose());
        return { status: 'retry' };
    });
    const open = await startBatchHeldOn(harness, 'in-flight');

    await retainExpedited(harness, ['parked']);
    open();

    await expect.poll(() => disposals).toHaveLength(1);
    await Promise.all(disposals);
    expect(harness.log).toEqual(['run:in-flight', 'read:parked', 'run:parked']);
});

it('refuses an expedited row given no run', async () => {
    const harness = createExpediteHarness(16);
    const open = await startBatchHeldOn(harness, 'in-flight');

    expect(() => harness.handler.expedite([newWorkEntry('AL_TEST', 'parked').key], 0))
        .toThrow('An expedited row is given at least one run');
    open();
});
