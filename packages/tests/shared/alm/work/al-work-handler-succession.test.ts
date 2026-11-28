import {
    describe,
    expect,
    expectTypeOf,
    it,
    onTestFinished
} from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type {
    ALWorkAttemptResult,
    ALWorkBatchDiagnostics,
    ALWorkHandlerDependencies,
    ALWorkSuccessorClaim
} from '@shared/alm/work/al-work-handler.ts';
import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler, toALWorkOutcome } from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkOutcome, ALWorkRelease } from '@shared/alm/work/al-work-queue-port.ts';

import {
    createEngine,
    createRecordingPort,
    toFakeALWorkClaim,
    toTestALWorkReadySelection
} from './al-work-test-entries.ts';

/** The succession the successor cases' claims name when the case reads no particular one. */
const TEST_SUCCESSION = 'succession';

/** A batch age no successor case that reads no age reaches: its clock stands still. */
const TEST_UNTIL_BATCH_AGE_MS = 60_000;

/** The batch age limit the age-bound cases' owner states. */
const SUCCESSION_AGE_LIMIT_MS = 500;

describe('ALWorkHandler successor claims', () => {
    // Pins that a successor found by the succession its completed predecessor named runs in the same batch, flush
    // and counts, and that every release is written completed.
    it('runs the successor a completed claim hands its place to in the same batch, flush and counts', async () => {
        const flushes: ALWorkRelease[][] = [];
        const batches: ALWorkBatchDiagnostics[] = [];
        const runs: string[] = [];
        const successors: Record<string, string> = { 'chain-1': 'chain-2', 'chain-2': 'chain-3' };
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['chain-1'], flushes),
            claimSuccessor: toTestSuccessorClaim(async (_port, contextId) => {
                const successor = successors[contextId];
                return successor === undefined ? undefined : toFakeALWorkClaim(successor);
            }),
            runClaim: async (claim) => {
                runs.push(claim.entry.key.contextId);
                return { status: 'completed-with-succession', succession: claim.entry.key.contextId };
            },
            diagnostics: (event) => {
                if (event.kind === 'work-batch') {
                    batches.push(event);
                }
            }
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(runs).toEqual(['chain-1', 'chain-2', 'chain-3']);
        expect(flushes.map((flush) => flush.map((release) => `${release.claim.entry.key.contextId}:${release.outcome.status}`)))
            .toEqual([['chain-1:completed', 'chain-2:completed', 'chain-3:completed']]);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({ claimedCount: 3, completedCount: 3 });
    });

    // Pins that a claim that did not complete hands nothing on, whatever succession its owner would have found.
    it.each(['retry', 'non-retryable', 'not-ready', 'thrown'] as const)(
        'asks no successor of a claim that ended %s',
        async (ending) => {
            const asked: string[] = [];
            const runs: string[] = [];
            const handler = new ALWorkHandler<string>({
                ...createSuccessionDependencies<string>(['ended'], []),
                claimSuccessor: toTestSuccessorClaim(async (_port, succession) => {
                    asked.push(succession);
                    return toFakeALWorkClaim('never-run');
                }),
                runClaim: async (claim): Promise<ALWorkAttemptResult<string>> => {
                    runs.push(claim.entry.key.contextId);
                    switch (ending) {
                        case 'thrown':
                            throw new Error('The claim failed');
                        case 'not-ready':
                            return { status: 'not-ready', readyAtMs: 2_000 };
                        case 'retry':
                        case 'non-retryable':
                            return { status: ending };
                    }
                }
            });
            onTestFinished(() => handler.dispose());

            await handler.ready();

            expect(runs).toEqual(['ended']);
            expect(asked).toEqual([]);
        }
    );

    // Pins that a throwing successor claim is stated as a storage failure and strands none of the selected claims.
    it('runs the claims it selected when a successor cannot be claimed, and states the failure', async () => {
        const runs: string[] = [];
        const events: ALStorageEvent[] = [];
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['first', 'second'], []),
            claimSuccessor: toTestSuccessorClaim(async () => {
                throw new DOMException('The successor read failed', 'QuotaExceededError');
            }),
            runClaim: async (claim) => {
                runs.push(claim.entry.key.contextId);
                return { status: 'completed-with-succession', succession: TEST_SUCCESSION };
            },
            storageHealth: new ALStorageHealth({ storeId: 'store-1', storage: (event) => events.push(event) })
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(runs).toEqual(['first', 'second']);
        expect(events.some((event) => event.kind === 'health' && event.status === 'failing')).toBe(true);
    });

    // Pins the page bound: successors count toward the page, so no batch runs more than a page.
    it('runs at most a page per batch, its successors included', async () => {
        const runs: string[] = [];
        let promoted = 0;
        const claimSuccessor = async () => toFakeALWorkClaim(`promoted-${(promoted += 1)}`);
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['page-1', 'page-2'], []),
            pageSize: 4,
            claimSuccessor: toTestSuccessorClaim(claimSuccessor),
            runClaim: async (claim) => {
                runs.push(claim.entry.key.contextId);
                return { status: 'completed-with-succession', succession: TEST_SUCCESSION };
            }
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(runs).toEqual(['page-1', 'page-2', 'promoted-1', 'promoted-2']);
        expect(promoted).toBe(2);
    });

    // Pins that the age bound leaves a young batch's hand-on as it was: a completion one millisecond before the limit
    // still runs its successor in the same batch.
    it('hands on a completion that comes before the batch reaches its age limit', async () => {
        const scenario = runAgedSuccession(SUCCESSION_AGE_LIMIT_MS - 1);

        expect(await scenario.ran).toEqual(['aged', 'successor']);
        expect(scenario.asked).toEqual(['aged', 'successor']);
    });

    // Pins the age bound: a completion once the batch has run its limit asks the owner for no successor, and the
    // batch ends with exactly the claim it selected, completed.
    it('asks no successor of a completion once the batch has run its age limit', async () => {
        const scenario = runAgedSuccession(SUCCESSION_AGE_LIMIT_MS + 1);

        expect(await scenario.ran).toEqual(['aged']);
        expect(scenario.asked).toEqual([]);
        expect(scenario.flushes.map((flush) => flush.map((release) => `${release.claim.entry.key.contextId}:${release.outcome.status}`)))
            .toEqual([['aged:completed']]);
        expect(scenario.batches).toHaveLength(1);
        expect(scenario.batches[0]).toMatchObject({
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0,
            durationMs: SUCCESSION_AGE_LIMIT_MS + 1
        });
    });

    // Pins the bound's edge: a batch exactly as old as its limit hands nothing on (the limit is reached, not passed).
    it('asks no successor of a completion at exactly the batch age limit', async () => {
        const scenario = runAgedSuccession(SUCCESSION_AGE_LIMIT_MS);

        expect(await scenario.ran).toEqual(['aged']);
        expect(scenario.asked).toEqual([]);
    });

    // Pins that a plain completion names nothing to hand on, so its owner is asked for no successor.
    it('asks no successor of a claim that completed naming no succession', async () => {
        const asked: string[] = [];
        const runs: string[] = [];
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['plain'], []),
            claimSuccessor: toTestSuccessorClaim(async (_port, succession) => {
                asked.push(succession);
                return toFakeALWorkClaim('never-run');
            }),
            runClaim: async (claim) => {
                runs.push(claim.entry.key.contextId);
                return { status: 'completed' };
            }
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(runs).toEqual(['plain']);
        expect(asked).toEqual([]);
    });

    // Pins that the handler passes on the owner's own value, not a copy or the claim it came from.
    it('hands the owner the very succession the completed claim named', async () => {
        const succession = { trackKey: 'track-1', completedThrough: 3 };
        const asked: (typeof succession)[] = [];
        const handler = new ALWorkHandler<typeof succession>({
            ...createSuccessionDependencies<typeof succession>(['named'], []),
            claimSuccessor: toTestSuccessorClaim(async (_port, named) => {
                asked.push(named);
                return undefined;
            }),
            runClaim: async () => ({ status: 'completed-with-succession', succession })
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(asked).toHaveLength(1);
        expect(asked[0]).toBe(succession);
    });

    // Pins that the release a claim naming a succession is written with is the plain completed outcome.
    it('writes the release of a claim that named a succession as completed', async () => {
        const flushes: ALWorkRelease[][] = [];
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['named'], flushes),
            claimSuccessor: toTestSuccessorClaim(async () => undefined),
            runClaim: async () => ({ status: 'completed-with-succession', succession: TEST_SUCCESSION })
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(flushes.map((flush) => flush.map((release) => release.outcome))).toEqual([[{ status: 'completed' }]]);
    });

    // Pins that a claim its group ran hands its succession on as one run alone does.
    it('asks the successor of a grouped claim that named a succession', async () => {
        const asked: string[] = [];
        const runs: string[] = [];
        const handler = new ALWorkHandler<string>({
            ...createSuccessionDependencies<string>(['grouped'], []),
            claimSuccessor: toTestSuccessorClaim(async (_port, succession) => {
                asked.push(succession);
                return succession === 'grouped' ? toFakeALWorkClaim('successor') : undefined;
            }),
            runClaimGroup: (claims) =>
                new Map(claims.map((claim) => [
                    claim,
                    Promise.resolve({ status: 'completed-with-succession', succession: claim.entry.key.contextId } as const)
                ])),
            runClaim: async (claim) => {
                runs.push(claim.entry.key.contextId);
                return { status: 'completed' };
            }
        });
        onTestFinished(() => handler.dispose());

        await handler.ready();

        expect(asked).toEqual(['grouped']);
        expect(runs).toEqual(['successor']);
    });
});

describe('toALWorkOutcome', () => {
    // Pins the one translation from a claim's result to the outcome its release is written with.
    it('answers completed for a claim that named a succession, and any other outcome as it is', () => {
        const outcomes: readonly ALWorkOutcome[] = [
            { status: 'completed' },
            { status: 'retry' },
            { status: 'non-retryable' },
            { status: 'not-ready', readyAtMs: 2_000 }
        ];

        expect(toALWorkOutcome({ status: 'completed-with-succession', succession: TEST_SUCCESSION }))
            .toEqual({ status: 'completed' });
        for (const outcome of outcomes) {
            expect(toALWorkOutcome(outcome)).toBe(outcome);
        }
    });
});

describe('ALWorkHandler with no succession', () => {
    // Pins that an owner with no succession can neither answer one nor pass a successor claim that would never be
    // asked: its claims' statuses are the plain outcomes and `retained`, and its successor claim is undefined.
    it('admits no succession status and no successor claim', () => {
        expectTypeOf<ALWorkAttemptResult['status']>()
            .toEqualTypeOf<ALWorkOutcome['status'] | 'retained'>();
        expectTypeOf<ALWorkHandlerDependencies['claimSuccessor']>().toEqualTypeOf<undefined>();
        expectTypeOf<ALWorkHandlerDependencies<string>['claimSuccessor']>()
            .toEqualTypeOf<ALWorkSuccessorClaim<string> | undefined>();
    });
});

/**
 * A handler's dependencies over a port that holds `claims` and keeps each flush in `flushes`, for the cases that
 * state only their owner's part.
 */
function createSuccessionDependencies<TSuccession>(
    claims: readonly string[],
    flushes: ALWorkRelease[][]
): ALWorkHandlerDependencies<TSuccession> {
    return {
        workerId: 'successor-worker',
        port: createRecordingPort(claims, flushes),
        queueEngine: createEngine(),
        ownsQueueEngine: false,
        clock: { nowMs: () => 1_000 },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (port, size) => toTestALWorkReadySelection(await port.claim({ maxCount: size, observedEntries: undefined })),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    };
}

interface AgedSuccessionScenario {
    /** The claims the batch ran, in order, once its batch has ended. */
    readonly ran: Promise<readonly string[]>;
    /** The successions the owner was asked for, in order. */
    readonly asked: readonly string[];
    readonly flushes: readonly (readonly ALWorkRelease[])[];
    readonly batches: readonly ALWorkBatchDiagnostics[];
}

/**
 * One batch whose selected claim `aged` completes when the batch is `ageMs` old, naming a succession its owner answers
 * with `successor`, which completes at once. The batch starts on a clock at 1 000 and its owner's limit is
 * `SUCCESSION_AGE_LIMIT_MS`.
 */
function runAgedSuccession(ageMs: number): AgedSuccessionScenario {
    const batchStartedAtMs = 1_000;
    let nowMs = batchStartedAtMs;
    const runs: string[] = [];
    const asked: string[] = [];
    const flushes: ALWorkRelease[][] = [];
    const batches: ALWorkBatchDiagnostics[] = [];
    const handler = new ALWorkHandler<string>({
        ...createSuccessionDependencies<string>(['aged'], flushes),
        clock: { nowMs: () => nowMs },
        claimSuccessor: {
            claim: async (_port, succession) => {
                asked.push(succession);
                return succession === 'aged' ? toFakeALWorkClaim('successor') : undefined;
            },
            untilBatchAgeMs: SUCCESSION_AGE_LIMIT_MS
        },
        runClaim: async (claim) => {
            const contextId = claim.entry.key.contextId;
            runs.push(contextId);
            if (contextId === 'aged') {
                nowMs = batchStartedAtMs + ageMs;
            }
            return { status: 'completed-with-succession', succession: contextId };
        },
        diagnostics: (event) => {
            if (event.kind === 'work-batch') {
                batches.push(event);
            }
        }
    });
    onTestFinished(() => handler.dispose());
    return { ran: handler.ready().then(() => runs), asked, flushes, batches };
}

/** The owner's successor claim, for the cases that read no batch age. */
function toTestSuccessorClaim<TSuccession>(
    claim: ALWorkSuccessorClaim<TSuccession>['claim']
): ALWorkSuccessorClaim<TSuccession> {
    return { claim, untilBatchAgeMs: TEST_UNTIL_BATCH_AGE_MS };
}
