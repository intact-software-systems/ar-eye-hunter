import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkOutcome, ALWorkRelease } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { newWorkEntry, toTestALWorkReadySelection } from './al-work-test-entries.ts';

it('awaited disposal joins the mandatory release of a directly committed batch', async () => {
    const nowMs = 10_000;
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
    const realPort = createALWorkQueuePort({
        queue,
        workTypes: new Set(['AL_TEST']),
        leaseMs: 5_000,
        nowMs: () => nowMs,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
    const releaseStarted = Promise.withResolvers<void>();
    const releaseAllowed = Promise.withResolvers<void>();
    const releaseCompleted = Promise.withResolvers<void>();
    const port = {
        ...realPort,
        releaseAll: async (releases: readonly ALWorkRelease[]) => {
            if (releases.length > 0) {
                releaseStarted.resolve();
                await releaseAllowed.promise;
            }
            await realPort.releaseAll(releases);
            if (releases.length > 0) {
                releaseCompleted.resolve();
            }
        }
    };
    const handler = new ALWorkHandler({
        workerId: 'disposal-worker',
        port,
        queueEngine: new InboxOutboxEngine(),
        ownsQueueEngine: false,
        clock: { nowMs: () => nowMs },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (claimed, size) =>
            toTestALWorkReadySelection(
                await claimed.claim({ maxCount: size, observedEntries: undefined })
            ),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
    await handler.ready();
    const entry = newWorkEntry('AL_TEST', 'dispose-in-flight');
    await port.retainIfAbsent(entry);
    handler.committed({ dueByMs: nowMs, writtenKeys: [] });
    await releaseStarted.promise;
    let disposed = false;
    const disposal = Promise.resolve(handler.dispose()).then(() => {
        disposed = true;
    });
    try {
        await Promise.resolve();
        expect(disposed, 'Disposal must remain pending while its real queue release is blocked').toBe(false);
    }
    finally {
        releaseAllowed.resolve();
        await Promise.all([disposal, releaseCompleted.promise]);
    }
    expect((await port.readEntry(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    expect(disposed).toBe(true);
});

it('awaited disposal joins retained settlement and its release after the batch has ended', async () => {
    const nowMs = 10_000;
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
    const realPort = createALWorkQueuePort({
        queue,
        workTypes: new Set(['AL_TEST']),
        leaseMs: 5_000,
        nowMs: () => nowMs,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
    const settlement = Promise.withResolvers<ALWorkOutcome>();
    const releaseStarted = Promise.withResolvers<void>();
    const releaseAllowed = Promise.withResolvers<void>();
    const releaseCompleted = Promise.withResolvers<void>();
    const port = {
        ...realPort,
        releaseAll: async (releases: readonly ALWorkRelease[]) => {
            if (releases.length > 0) {
                releaseStarted.resolve();
                await releaseAllowed.promise;
            }
            await realPort.releaseAll(releases);
            if (releases.length > 0) {
                releaseCompleted.resolve();
            }
        }
    };
    const entry = newWorkEntry('AL_TEST', 'dispose-retained');
    await port.retainIfAbsent(entry);
    const handler = new ALWorkHandler({
        workerId: 'retained-disposal-worker',
        port,
        queueEngine: new InboxOutboxEngine(),
        ownsQueueEngine: false,
        clock: { nowMs: () => nowMs },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (claimed, size) => toTestALWorkReadySelection(await claimed.claim({ maxCount: size, observedEntries: undefined })),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'retained', settled: settlement.promise }),
        diagnostics: undefined
    });
    await handler.ready();
    expect((await port.readEntry(entry.key))?.status).toBe(EntityStatus.RESERVED);
    let disposed = false;
    const disposal = Promise.resolve(handler.dispose()).then(() => {
        disposed = true;
    });
    try {
        await Promise.resolve();
        expect(disposed, 'Disposal must join retained work even when its batch has ended').toBe(false);
        settlement.resolve({ status: 'completed' });
        await releaseStarted.promise;
        expect(disposed, 'Retained settlement must not finish disposal before its real release').toBe(false);
    }
    finally {
        settlement.resolve({ status: 'completed' });
        releaseAllowed.resolve();
        await Promise.all([disposal, releaseCompleted.promise]);
    }
    expect((await port.readEntry(entry.key))?.status).toBe(EntityStatus.COMPLETED);
    expect(disposed).toBe(true);
});
