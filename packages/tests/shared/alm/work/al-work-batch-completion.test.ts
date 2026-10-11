import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { captureOutboundWorkRunnable } from '../outbound-runtime-test-fixture.ts';
import { newWorkEntry, toTestALWorkReadySelection } from './al-work-test-entries.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface BatchFailureCase {
    readonly primary?: Error;
    readonly followUp?: Error;
}

interface GatedCommitBatches {
    readonly handler: ALWorkHandler;
    readonly engine: InboxOutboxEngine;
    readonly port: ALWorkQueuePort;
    readonly runRegistered: () => Promise<void>;
    readonly firstEntered: PromiseWithResolvers<void>;
    readonly firstAllowed: PromiseWithResolvers<void>;
    readonly nextEntered: PromiseWithResolvers<void>;
    readonly nextAllowed: PromiseWithResolvers<void>;
    readonly nextEnded: PromiseWithResolvers<void>;
    readonly publications: string[];
}

function createGatedCommitBatches(failures: BatchFailureCase = {}): GatedCommitBatches {
    const firstEntered = Promise.withResolvers<void>();
    const firstAllowed = Promise.withResolvers<void>();
    const nextEntered = Promise.withResolvers<void>();
    const nextAllowed = Promise.withResolvers<void>();
    const nextEnded = Promise.withResolvers<void>();
    const publications: string[] = [];
    let nextLabel = 'first';
    class ObservedBatch extends ALWorkBatchObservations {
        readonly label = nextLabel;
        constructor() {
            super();
            nextLabel = 'follow-up';
        }
        override publish(): void {
            super.publish();
            publications.push(this.label);
            if (this.label === 'follow-up') {
                nextEnded.resolve();
            }
        }
    }
    const engine = new InboxOutboxEngine();
    const runRegistered = captureOutboundWorkRunnable(engine);
    const port = createALWorkQueuePort({
        queue: new InMemoryQueueBox(),
        workTypes: new Set(['AL_TEST']),
        leaseMs: 5000,
        nowMs: Date.now,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
    let selectNext = false;
    const handler = new ALWorkHandler({
        workerId: 'al-outbound:commit-completion',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: Date.now },
        pageSize: 16,
        readinessMemoryMs: 0,
        readNextReadyAtMs: async () => undefined,
        claimSuccessor: undefined,
        batchObservations: ObservedBatch,
        selectReady: async (selected, size) => {
            const following = selectNext;
            selectNext = true;
            (following ? nextEntered : firstEntered).resolve();
            await (following ? nextAllowed : firstAllowed).promise;
            const failure = following ? failures.followUp : failures.primary;
            if (failure) {
                throw failure;
            }
            return toTestALWorkReadySelection(await selected.claim({ maxCount: size, observedEntries: undefined }));
        },
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
    return { handler, engine, port, runRegistered, firstEntered, firstAllowed, nextEntered, nextAllowed, nextEnded, publications };
}

it('registered owner operation joins the actual follow-up owed by a commit during its batch', async () => {
    vi.useFakeTimers();
    const fixture = createGatedCommitBatches();
    const first = newWorkEntry('AL_TEST', 'first');
    const next = newWorkEntry('AL_TEST', 'follow-up');
    await fixture.port.retainIfAbsent(first);
    let completed = false;
    const bootstrap = fixture.handler.ready();
    await fixture.firstEntered.promise;
    const working = fixture.runRegistered().then(() => {
        completed = true;
    });
    await fixture.port.retainIfAbsent(next);
    fixture.handler.committed({ dueByMs: Date.now(), writtenKeys: [] });
    fixture.firstAllowed.resolve();
    await fixture.nextEntered.promise;
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(completed, 'Owner completion escaped while its owed follow-up was blocked').toBe(false);
        expect(fixture.publications).toEqual(['first']);
        fixture.nextAllowed.resolve();
        await working;
        expect(fixture.publications).toEqual(['first', 'follow-up']);
        expect((await fixture.port.readEntry(first.key))?.status).toBe('COMPLETED');
        expect((await fixture.port.readEntry(next.key))?.status).toBe('COMPLETED');
    }
    finally {
        fixture.firstAllowed.resolve();
        fixture.nextAllowed.resolve();
        await fixture.nextEnded.promise;
        await Promise.all([bootstrap, working, fixture.handler.dispose(), fixture.engine.stop()]);
    }
});

it.each(['primary', 'follow-up', 'both'] as const)('keeps independent %s failure identity and both batch publications', async (failureCase) => {
    const primary = new ALAdmissionCorruptionError('first', new Error('first corruption'));
    const followUp = new ALAdmissionCorruptionError('follow-up', new Error('follow-up corruption'));
    const reported = Promise.withResolvers<Error>();
    const logged = vi.spyOn(console, 'error').mockImplementation((_message: string, error: Error) => {
        reported.resolve(error);
    });
    const fixture = createGatedCommitBatches({
        primary: failureCase === 'follow-up' ? undefined : primary,
        followUp: failureCase === 'primary' ? undefined : followUp
    });
    const working = fixture.handler.ready().then(() => undefined, (error: Error) => error);
    await fixture.firstEntered.promise;
    fixture.handler.committed({ dueByMs: Date.now(), writtenKeys: [] });
    fixture.firstAllowed.resolve();
    await fixture.nextEntered.promise;
    fixture.nextAllowed.resolve();
    await fixture.nextEnded.promise;
    expect(await working).toBe(failureCase === 'follow-up' ? undefined : primary);
    expect(fixture.publications).toEqual(['first', 'follow-up']);
    if (failureCase !== 'primary') {
        expect(await reported.promise).toBe(followUp);
        expect(logged).toHaveBeenCalledWith('ALM work batch failed', followUp);
    }
    await Promise.all([fixture.handler.dispose(), fixture.engine.stop()]);
});
