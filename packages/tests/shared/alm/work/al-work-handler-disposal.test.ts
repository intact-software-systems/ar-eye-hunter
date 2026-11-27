import { expect, it, onTestFinished, vi } from 'vitest';

import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkHandlerDependencies
} from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkOutcome, ALWorkRelease } from '@shared/alm/work/al-work-queue-port.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { fakePort, toFakeALWorkClaim, toTestALWorkReadySelection } from './al-work-test-entries.ts';

it.each(['selection', 'exhaustion'] as const)('releases claims returned after disposal during %s', async (phase) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const releases: ALWorkRelease[] = [];
    let groupsStarted = 0;
    const claims = [toFakeALWorkClaim('first'), toFakeALWorkClaim('second')];
    const handler = createHandler({
        port: {
            ...fakePort({ claims: [], onRelease: () => {} }),
            finalizeExhausted: async () => {
                if (phase !== 'exhaustion') {
                    return [];
                }
                entered.resolve();
                await resume.promise;
                return claims;
            },
            releaseAll: async (batch) => {
                releases.push(...batch);
            }
        },
        selectReady: async () => {
            entered.resolve();
            await resume.promise;
            return toTestALWorkReadySelection(claims);
        },
        runClaim: async () => {
            throw new Error('Disposal must prevent new attempts');
        },
        runClaimGroup: () => {
            groupsStarted += 1;
            return new Map();
        }
    });
    onTestFinished(() => {
        resume.resolve();
    });
    const running = handler.ready();
    await entered.promise;
    const disposing = handler.dispose();
    resume.resolve();
    await Promise.all([running, disposing]);
    expect(groupsStarted).toBe(0);

    expect(releases.map(({ claim, outcome }) => [claim.entry.key.contextId, outcome.status])).toEqual([
        ['first', phase === 'exhaustion' ? 'non-retryable' : 'not-ready'],
        ['second', phase === 'exhaustion' ? 'non-retryable' : 'not-ready']
    ]);
});

it('starts no reservation if the first work-clock read retires the handler', async () => {
    let disposing: Promise<void> | undefined;
    let reservations = 0;
    const nowMs = vi.fn(() => 1_000);
    const handler = createHandler({
        clock: { nowMs },
        port: {
            ...fakePort({ claims: [], onRelease: () => {} }),
            finalizeExhausted: async () => {
                reservations += 1;
                return [];
            }
        }
    });
    nowMs.mockImplementationOnce(() => {
        disposing = handler.dispose();
        return 1_000;
    });
    await handler.ready();
    await disposing;
    expect(reservations).toBe(0);
});

it('joins already started grouped attempts during disposal and releases each outcome', async () => {
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<ALWorkOutcome>();
    const second = Promise.withResolvers<ALWorkOutcome>();
    const releases: ALWorkRelease[] = [];
    const handler = createHandler({
        port: {
            ...fakePort({ claims: ['first', 'second'], onRelease: () => {} }),
            releaseAll: async (batch) => {
                releases.push(...batch);
            }
        },
        runClaimGroup: (claims) => {
            const attempts = new Map(claims.map((claim, index) => [claim, index === 0 ? first.promise : second.promise]));
            started.resolve();
            return attempts;
        },
        runClaim: async () => {
            throw new Error('Grouped work already started');
        }
    });
    onTestFinished(() => {
        first.resolve({ status: 'completed' });
        second.resolve({ status: 'retry' });
    });
    const running = handler.ready();
    await started.promise;
    const disposing = handler.dispose();
    first.resolve({ status: 'completed' });
    second.resolve({ status: 'retry' });
    await Promise.all([running, disposing]);

    expect(releases.map(({ claim, outcome }) => [claim.entry.key.contextId, outcome.status]))
        .toEqual([['first', 'completed'], ['second', 'retry']]);
});

it('releases a successor returned after disposal without starting its attempt', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const releases: ALWorkRelease[] = [];
    const attempted: string[] = [];
    const handler = createHandler<string>({
        port: {
            ...fakePort({ claims: ['first'], onRelease: () => {} }),
            releaseAll: async (batch) => {
                releases.push(...batch);
            }
        },
        claimSuccessor: async () => {
            entered.resolve();
            await resume.promise;
            return toFakeALWorkClaim('successor');
        },
        runClaim: async (claim) => {
            attempted.push(claim.entry.key.contextId);
            return { status: 'completed-with-succession', succession: 'successor' };
        }
    });
    onTestFinished(() => {
        resume.resolve();
    });
    const running = handler.ready();
    await entered.promise;
    const disposing = handler.dispose();
    resume.resolve();
    await Promise.all([running, disposing]);

    expect(attempted).toEqual(['first']);
    expect(releases.map(({ claim, outcome }) => [claim.entry.key.contextId, outcome.status]))
        .toEqual([['first', 'completed'], ['successor', 'not-ready']]);
});

function createHandler<TSuccession = never>(
    overrides: Partial<ALWorkHandlerDependencies<TSuccession>>
): ALWorkHandler<TSuccession> {
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const handler = new ALWorkHandler<TSuccession>({
        workerId: 'disposal-worker',
        port: fakePort({ claims: [], onRelease: () => {} }),
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => 1_000 },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (port, size) => toTestALWorkReadySelection(await port.claim({ maxCount: size, observedEntries: undefined })),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined,
        ...overrides
    });
    onTestFinished(() => handler.dispose());
    return handler;
}
