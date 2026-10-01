import { Temporal } from '@js-temporal/polyfill';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type {
    ALWorkAttemptResult,
    ALWorkBatchDiagnostics,
    ALWorkDiagnostics,
    ALWorkReadinessProbeDiagnostics,
    ALWorkReadySelection
} from '@shared/alm/work/al-work-handler.ts';
import { AL_WORK_PROBE_EVERY_ROUND, AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from '@shared/alm/work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it, vi } from 'vitest';
import { newWorkEntry, readTestALWorkReadyAtMs, toTestALWorkReadySelection } from './al-work-test-entries.ts';

const AL_TEST_TYPES: ReadonlySet<string> = new Set(['AL_TEST']);

// One distinct step per phase, so a field reporting another phase's time is visible on sight.
const PHASE_BATCH_START_MS = 1_000;
const PHASE_SELECTION_MS = 7;
const PHASE_CLAIM_MS = 3;
const PHASE_RUN_MS = 11;
const PHASE_RELEASE_MS = 5;
const PHASE_QUEUE_WAIT_MS = 40;

describe('ALWorkHandler', () => {
    it('runs one batch per wake, releases each claim once, and never awaits delivery on committed()', async () => {
        const released: string[] = [];
        const port = fakePort({
            claims: ['w-1', 'w-2'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => claim.entry.key.contextId === 'w-2' ? { status: 'retry' } : { status: 'completed' },
            diagnostics: undefined
        });
        await handler.ready();
        expect(released).toEqual(['w-1:completed', 'w-2:retry']);

        const before = Date.now();
        handler.committed({ dueByMs: 1_000, dueNowCount: 0 });
        expect(Date.now() - before).toBeLessThan(5);
        handler.dispose();
    });

    it('classifies thrown errors: corruption rejects, other errors retry, retained results settle later', async () => {
        const released: string[] = [];
        const port = fakePort({
            claims: ['c-1', 'c-2', 'c-3'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                switch (claim.entry.key.contextId) {
                    case 'c-1':
                        throw new ALAdmissionCorruptionError('k', new TypeError('x'));
                    case 'c-2':
                        throw new Error('transient');
                    default:
                        return { status: 'retained', settled: Promise.resolve({ status: 'completed' }) };
                }
            },
            diagnostics: undefined
        });

        await handler.ready();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The retained claim releases on its own settlement, outside the batch's one flush, so only the
        // two the flush wrote have an order relative to each other.
        expect(released.filter((entry) => entry !== 'c-3:completed')).toEqual(['c-1:non-retryable', 'c-2:retry']);
        expect(released).toContain('c-3:completed');
        handler.dispose();
    });

    it('resolves ready() only once the batch its bootstrap started has settled', async () => {
        const released: string[] = [];
        const port = fakePort({
            claims: ['slow-1'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        let releaseClaim: (() => void) | undefined;
        const claimGate = new Promise<void>((resolve) => {
            releaseClaim = resolve;
        });
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => {
                await claimGate;
                return { status: 'completed' };
            },
            diagnostics: undefined
        });

        const readyPromise = handler.ready();
        expect(released).toEqual([]);

        releaseClaim?.();
        await readyPromise;
        expect(released).toEqual(['slow-1:completed']);
        handler.dispose();
    });

    it('finalizes a seeded exhausted claim as non-retryable and counts it in diagnostics', async () => {
        const released: string[] = [];
        const diagnosticsEvents: ALWorkDiagnostics[] = [];
        const port = fakePort({
            claims: [],
            finalizeExhausted: ['exhausted-1'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: (event) => diagnosticsEvents.push(event)
        });

        await handler.ready();

        expect(released).toEqual(['exhausted-1:non-retryable']);
        const batches = diagnosticsEvents.filter((event): event is ALWorkBatchDiagnostics => event.kind === 'work-batch');
        expect(batches).toHaveLength(1);
        expect(batches[0]).toMatchObject({
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 1
        });

        handler.dispose();
    });

    it('splits one batch into its selection, its reservation, its claims and their releases', async () => {
        const diagnosticsEvents: ALWorkDiagnostics[] = [];
        const claims = [toFakeALWorkClaim('phase-1'), toFakeALWorkClaim('phase-2')];
        const receivedBatchStarts: number[] = [];
        let nowMs = PHASE_BATCH_START_MS;
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: () => {} }),
            releaseAll: async () => {
                nowMs += PHASE_RELEASE_MS;
            }
        };
        const handler = new ALWorkHandler({
            workerId: 'phase-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async () => {
                nowMs += PHASE_SELECTION_MS + PHASE_CLAIM_MS;
                return {
                    claims,
                    nextReadyAtMs: undefined,
                    selectionDurationMs: PHASE_SELECTION_MS,
                    claimDurationMs: PHASE_CLAIM_MS,
                    earliestDueAtMs: PHASE_BATCH_START_MS - PHASE_QUEUE_WAIT_MS
                };
            },
            runClaim: async (_claim, batchStartedAtMs) => {
                receivedBatchStarts.push(batchStartedAtMs);
                nowMs += PHASE_RUN_MS;
                return { status: 'completed' };
            },
            diagnostics: (event) => diagnosticsEvents.push(event)
        });

        await handler.ready();

        // Every claim measures its wait from the run loop's start, after the selection and the
        // reservation: the first claim waits behind nothing, the second behind the first alone.
        const runLoopStartedAtMs = PHASE_BATCH_START_MS + PHASE_SELECTION_MS + PHASE_CLAIM_MS;
        expect(receivedBatchStarts).toEqual([runLoopStartedAtMs, runLoopStartedAtMs]);
        // Two claims run, so a per-claim phase is visibly doubled while the one flush that released
        // them both is not.
        expect(diagnosticsEvents.filter((event) => event.kind === 'work-batch')).toEqual([{
            kind: 'work-batch',
            workerId: 'phase-worker',
            durationMs: PHASE_SELECTION_MS + PHASE_CLAIM_MS + 2 * PHASE_RUN_MS + PHASE_RELEASE_MS,
            claimedCount: 2,
            completedCount: 2,
            rescheduledCount: 0,
            rejectedCount: 0,
            selectionDurationMs: PHASE_SELECTION_MS,
            claimDurationMs: PHASE_CLAIM_MS,
            runDurationMs: 2 * PHASE_RUN_MS,
            releaseDurationMs: PHASE_RELEASE_MS,
            queueWaitMs: PHASE_QUEUE_WAIT_MS,
            startedAtMs: runLoopStartedAtMs
        }]);

        handler.dispose();
    });

    it('counts the exhaustion sweep\'s own release in the batch it ran in', async () => {
        const diagnosticsEvents: ALWorkDiagnostics[] = [];
        let nowMs = PHASE_BATCH_START_MS;
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], finalizeExhausted: ['exhausted-phase'], onRelease: () => {} }),
            releaseAll: async () => {
                nowMs += PHASE_RELEASE_MS;
            }
        };
        const handler = new ALWorkHandler({
            workerId: 'sweep-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async () => toTestALWorkReadySelection([]),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: (event) => diagnosticsEvents.push(event)
        });

        await handler.ready();

        // The sweep runs no claim, so its time is a release and nothing else.
        expect(diagnosticsEvents.filter((event) => event.kind === 'work-batch')).toEqual([{
            kind: 'work-batch',
            workerId: 'sweep-worker',
            durationMs: PHASE_RELEASE_MS,
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 1,
            selectionDurationMs: 0,
            claimDurationMs: 0,
            runDurationMs: 0,
            releaseDurationMs: PHASE_RELEASE_MS,
            queueWaitMs: 0,
            startedAtMs: PHASE_BATCH_START_MS
        }]);

        handler.dispose();
    });

    it('starts a batch through the engine\'s isWork -> runnable path when the probe reports due work', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let dueAtMs: number | undefined;
        const port: ALWorkQueuePort = {
            retainIfAbsent: async (entry) => entry,
            readPage: async () => ({ entries: [], nextCursor: null }),
            readPages: async (inputs) => inputs.map(() => ({ entries: [], hasMoreEntries: false })),
            claim: async ({ maxCount }) => pending.splice(0, maxCount),
            finalizeExhausted: async () => [],
            releaseAll: async (releases) => {
                for (const release of releases) {
                    released.push(`${release.claim.entry.key.contextId}:${release.outcome.status}`);
                }
            },
            readEntry: async () => undefined
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => Date.now() },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                const next = dueAtMs;
                dueAtMs = undefined;
                return next;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        expect(released).toEqual([]);

        // Work becomes due only after bootstrap; the isWork -> runnable path owned by the engine
        // must discover it through the probe and wakeAt rather than the ready() bootstrap batch.
        pending.push(toFakeALWorkClaim('engine-driven'));
        dueAtMs = Date.now() - 1;

        await expect.poll(async () => {
            await engine.executeOnce();
            return released;
        }).toEqual(['engine-driven:completed']);

        handler.dispose();
    });

    it('drives readiness from the injected probe alone', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        const port = fakePort({
            claims: [],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const probing: ALWorkQueuePort = {
            ...port,
            claim: async ({ maxCount }) => pending.splice(0, maxCount)
        };
        let nowMs = 10_000;
        let probedReadyAtMs: number | undefined;
        const engine = createEngine();
        const wakeAtCalls: (number | undefined)[] = [];
        const wakeAt = engine.wakeAt.bind(engine);
        vi.spyOn(engine, 'wakeAt').mockImplementation((taskId, readyAtMs) => {
            wakeAtCalls.push(readyAtMs);
            wakeAt(taskId, readyAtMs);
        });
        const handler = new ALWorkHandler({
            workerId: 'probe-worker',
            port: probing,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                const next = probedReadyAtMs;
                probedReadyAtMs = undefined;
                return next;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        wakeAtCalls.length = 0;

        // A future probe answer only reschedules: the engine must not run the batch that would claim it.
        pending.push(toFakeALWorkClaim('later'));
        probedReadyAtMs = nowMs + 60_000;
        await engine.executeOnce();
        expect(wakeAtCalls).toContain(nowMs + 60_000);
        expect(released).toEqual([]);

        // The same probe reporting a due time starts the batch, through the engine alone. The probe is
        // reached again only once the remembered future answer ages out: nothing else changed a row.
        nowMs += AL_WORK_READINESS_MEMORY_MS;
        probedReadyAtMs = nowMs;
        await expect.poll(async () => {
            await engine.executeOnce();
            return released;
        }).toEqual(['later:completed']);

        handler.dispose();
    });

    it('runs a follow-up batch for work committed mid-batch, without the engine ever running', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let claimCallCount = 0;
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let signalFirstClaimEntered: (() => void) | undefined;
        const firstClaimEntered = new Promise<void>((resolve) => {
            signalFirstClaimEntered = resolve;
        });
        const port: ALWorkQueuePort = {
            retainIfAbsent: async (entry) => entry,
            readPage: async () => ({ entries: [], nextCursor: null }),
            readPages: async (inputs) => inputs.map(() => ({ entries: [], hasMoreEntries: false })),
            claim: async ({ maxCount }) => {
                claimCallCount += 1;
                return pending.splice(0, maxCount);
            },
            finalizeExhausted: async () => [],
            releaseAll: async (releases) => {
                for (const release of releases) {
                    released.push(`${release.claim.entry.key.contextId}:${release.outcome.status}`);
                }
            },
            readEntry: async () => undefined
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                if (claim.entry.key.contextId === 'first') {
                    signalFirstClaimEntered?.();
                    await firstGate;
                }
                return { status: 'completed' };
            },
            diagnostics: undefined
        });

        // The engine is never started (ownsQueueEngine: false), so only the bootstrap batch runs here.
        await handler.ready();
        claimCallCount = 0;

        // Seed the claim that a mid-batch commit must reach only through the follow-up batch: wait
        // for the claim() call of this batch to run and capture it before the second entry exists.
        pending.push(toFakeALWorkClaim('first'));
        handler.committed({ dueByMs: 1_000, dueNowCount: 1 });
        await firstClaimEntered;

        // A second commit lands, and its work becomes claimable, while the first entry is still in flight.
        pending.push(toFakeALWorkClaim('second'));
        handler.committed({ dueByMs: 1_000, dueNowCount: 1 });

        releaseFirst?.();
        await expect.poll(() => released).toEqual(['first:completed', 'second:completed']);

        // Two distinct claim() calls after ready() prove the second entry arrived through the follow-up
        // batch that the finally block of runBatch() starts, not through the claim() call of the first batch.
        expect(claimCallCount).toBe(2);
        handler.dispose();
    });

    it('flushes one batch of mixed outcomes in a single releaseAll, in claim order', async () => {
        const flushes: ALWorkRelease[][] = [];
        const port = recordingPort(['flush-1', 'flush-2', 'flush-3'], flushes);
        const handler = new ALWorkHandler({
            workerId: 'flush-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                switch (claim.entry.key.contextId) {
                    case 'flush-2':
                        return { status: 'retry' };
                    case 'flush-3':
                        return { status: 'non-retryable' };
                    default:
                        return { status: 'completed' };
                }
            },
            diagnostics: undefined
        });

        await handler.ready();

        expect(flushes).toHaveLength(1);
        expect(flushes[0]!.map((release) => `${release.claim.entry.key.contextId}:${release.outcome.status}`))
            .toEqual(['flush-1:completed', 'flush-2:retry', 'flush-3:non-retryable']);
        handler.dispose();
    });

    it('flushes the claim a disposed batch already ran before it abandons the rest', async () => {
        const flushes: ALWorkRelease[][] = [];
        const port = recordingPort(['abort-1', 'abort-2'], flushes);
        let handler: ALWorkHandler | undefined;
        handler = new ALWorkHandler({
            workerId: 'abort-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => {
                handler?.dispose();
                return { status: 'completed' };
            },
            diagnostics: undefined
        });

        await handler.ready();

        // The second claim is never run, and the first is not stranded reserved by the disposal.
        expect(flushes).toHaveLength(1);
        expect(flushes[0]!.map((release) => release.claim.entry.key.contextId)).toEqual(['abort-1']);
    });

    it('flushes a collected exhaustion finalization even when the selection throws', async () => {
        const flushes: ALWorkRelease[][] = [];
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const port: ALWorkQueuePort = {
            ...recordingPort([], flushes),
            finalizeExhausted: async () => [toFakeALWorkClaim('stranded-finalization')]
        };
        const handler = new ALWorkHandler({
            workerId: 'stranded-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async () => {
                throw new Error('selection storage unavailable');
            },
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();

        // The sweep already reserved the row, so a thrown selection must not leave it waiting for
        // its lease to expire.
        expect(flushes.map((flush) => flush.map((release) => release.claim.entry.key.contextId)))
            .toEqual([['stranded-finalization']]);
        expect(consoleErrorSpy).toHaveBeenCalledWith('ALM work batch failed', expect.any(Error));
        consoleErrorSpy.mockRestore();
        handler.dispose();
    });

    it('selects no work once dispose() lands while the exhausted-work finalization is in flight', async () => {
        let selectCallCount = 0;
        const finalizeEntered = Promise.withResolvers<void>();
        const releaseFinalize = Promise.withResolvers<void>();
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: () => {} }),
            finalizeExhausted: async () => {
                finalizeEntered.resolve();
                await releaseFinalize.promise;
                return [];
            }
        };
        const handler = new ALWorkHandler({
            workerId: 'disposed-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async () => {
                selectCallCount += 1;
                return toTestALWorkReadySelection([]);
            },
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        const bootstrap = handler.ready();
        await finalizeEntered.promise;
        handler.dispose();
        releaseFinalize.resolve();
        await bootstrap;

        expect(selectCallCount).toBe(0);
    });

    it('re-attempts a claim that keeps losing its compare-and-set only once the port reschedules it', async () => {
        let nowMs = 10_000;
        const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
        const port = createALWorkQueuePort({
            queue,
            workTypes: AL_TEST_TYPES,
            leaseMs: 5_000,
            nowMs: () => nowMs,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'cas-loser'));
        let attemptCount = 0;
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'cas-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: () => readTestALWorkReadyAtMs(queue, AL_TEST_TYPES, nowMs),
            selectReady: async (claimed, size) => toTestALWorkReadySelection(await claimed.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => {
                attemptCount += 1;
                return { status: 'retry' };
            },
            diagnostics: undefined
        });

        await handler.ready();
        expect(attemptCount).toBe(1);
        const rescheduled = await port.readEntry(newWorkEntry('AL_TEST', 'cas-loser').key);
        expect(rescheduled?.status).toBe(EntityStatus.RETRY);
        expect(rescheduled?.dequeueAudit.nextTs?.epochMilliseconds).toBe(10_001);

        // Engine passes are unbounded; the lost attempt is bounded by the port's retry schedule alone.
        for (let pass = 0; pass < 25; pass += 1) {
            await engine.executeOnce();
        }
        expect(attemptCount).toBe(1);

        nowMs = 10_001;
        await engine.executeOnce();
        expect(attemptCount).toBe(2);

        // The second loss earns the policy's second delay, so the same passes still buy no attempt.
        for (let pass = 0; pass < 25; pass += 1) {
            await engine.executeOnce();
        }
        expect(attemptCount).toBe(2);
        expect((await port.readEntry(newWorkEntry('AL_TEST', 'cas-loser').key))?.dequeueAudit.nextTs?.epochMilliseconds)
            .toBe(10_003);

        handler.dispose();
    });

    it('leaves an empty batch to the probe\'s next ready time instead of re-entering on the same tick', async () => {
        const nowMs = 10_000;
        const readyAtMs = nowMs + 30_000;
        let selectCallCount = 0;
        const engine = createEngine();
        const wakeAtCalls: (number | undefined)[] = [];
        const wakeAt = engine.wakeAt.bind(engine);
        vi.spyOn(engine, 'wakeAt').mockImplementation((taskId, value) => {
            wakeAtCalls.push(value);
            wakeAt(taskId, value);
        });
        const wakeCalls: number[] = [];
        const wake = engine.wake.bind(engine);
        vi.spyOn(engine, 'wake').mockImplementation(() => {
            wakeCalls.push(selectCallCount);
            wake();
        });
        const handler = new ALWorkHandler({
            workerId: 'idle-worker',
            port: fakePort({ claims: [], onRelease: () => {} }),
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => readyAtMs,
            selectReady: async () => {
                selectCallCount += 1;
                return toTestALWorkReadySelection([], readyAtMs);
            },
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();

        // The batch claimed nothing: it advertises the probe's next time and wakes no one.
        expect(selectCallCount).toBe(1);
        expect(wakeAtCalls).toEqual([readyAtMs]);
        expect(wakeCalls).toEqual([]);

        for (let pass = 0; pass < 25; pass += 1) {
            await engine.executeOnce();
        }
        expect(selectCallCount).toBe(1);
        expect(new Set(wakeAtCalls)).toEqual(new Set([readyAtMs]));
        expect(wakeCalls).toEqual([]);

        handler.dispose();
    });

    it('answers a thousand idle engine rounds from the one storage probe that opened them', async () => {
        let probeCount = 0;
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'memory-worker',
            port: fakePort({ claims: [], onRelease: () => {} }),
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 10_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                probeCount += 1;
                return undefined;
            },
            selectReady: async () => toTestALWorkReadySelection([]),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        probeCount = 0;

        for (let round = 0; round < 1_000; round += 1) {
            await engine.executeOnce();
        }

        expect(probeCount).toBe(1);
        handler.dispose();
    });

    it('reads nothing for its own commit whose batch claimed it clean, and probes once after an engine batch', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let probeCount = 0;
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`) }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount)
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'commit-memory-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 10_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                probeCount += 1;
                return pending.length > 0 ? 10_000 : undefined;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        probeCount = 0;
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(1);

        // A commit of this owner's own sets the answer aside; the batch it runs claims and completes the
        // row it wrote, which leaves storage as the answer saw it.
        pending.push(toFakeALWorkClaim('committed-row'));
        handler.committed({ dueByMs: 10_000, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(released).toEqual(['committed-row:completed']);
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(1);

        // A batch the engine itself starts is worth exactly one probe to open it and one to close it.
        pending.push(toFakeALWorkClaim('engine-row'));
        engine.wakeAfterExternalWrite();
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(released).toEqual(['committed-row:completed', 'engine-row:completed']);
        expect(probeCount).toBe(3);

        handler.dispose();
    });

    it('names what emptied the memory every probe replaces', async () => {
        const probes: ALWorkReadinessProbeDiagnostics[] = [];
        const pending: ALWorkClaim[] = [];
        let nowMs = 10_000;
        let nextReadyAtMs: number | undefined;
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: () => {} }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount)
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'probe-cause-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => nextReadyAtMs,
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => claim.entry.key.contextId === 'retried-row' ? { status: 'retry' } : { status: 'completed' },
            diagnostics: (event) => collectProbe(probes, event)
        });

        // The bootstrap batch empties nothing: no probe has taken a memory for it to invalidate.
        await handler.ready();
        await engine.executeOnce();

        // A commit whose batch completes everything it claimed costs no probe at all.
        pending.push(toFakeALWorkClaim('committed-row'));
        handler.committed({ dueByMs: nowMs, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await engine.executeOnce();

        // A row nothing can claim yet: the probe reports the time it comes due, not that there is none.
        nextReadyAtMs = 15_000;
        engine.wakeAfterExternalWrite();
        await engine.executeOnce();

        nowMs += AL_WORK_READINESS_MEMORY_MS;
        await engine.executeOnce();

        // A commit whose batch leaves a row behind runs that batch, and the batch's own invalidation
        // must not take the commit's credit.
        pending.push(toFakeALWorkClaim('retried-row'));
        handler.committed({ dueByMs: nowMs, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await engine.executeOnce();

        // The clock never moves here, so every probe reports the read it made as free.
        expect(probes).toEqual([
            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'no-memory', readyAtMs: 'none', durationMs: 0 },
            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'external-wake', readyAtMs: 15_000, durationMs: 0 },
            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'age-bound', readyAtMs: 15_000, durationMs: 0 },
            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'own-commit', readyAtMs: 15_000, durationMs: 0 }
        ]);

        handler.dispose();
    });

    it('re-probes storage when a retained claim settles after its own batch ended', async () => {
        const probes: ALWorkReadinessProbeDiagnostics[] = [];
        const released: string[] = [];
        const pending: ALWorkClaim[] = [toFakeALWorkClaim('retained-row')];
        let probeCount = 0;
        let settleRetained: ((outcome: ALWorkOutcome) => void) | undefined;
        const settled = new Promise<ALWorkOutcome>((resolve) => {
            settleRetained = resolve;
        });
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`) }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount)
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'retained-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 10_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                probeCount += 1;
                return undefined;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'retained', settled }),
            diagnostics: (event) => collectProbe(probes, event)
        });

        await handler.ready();
        probeCount = 0;
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(1);
        expect(released).toEqual([]);

        // The release lands after the batch ended: it is a row change no batch boundary covers.
        settleRetained?.({ status: 'retry' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(released).toEqual(['retained-row:retry']);

        await engine.executeOnce();
        expect(probeCount).toBe(2);
        // The release, not the batch that ended long before it, is what emptied the standing memory.
        expect(probes.map((probe) => probe.cause)).toEqual(['no-memory', 'retained-release']);

        handler.dispose();
    });

    it('claims a row another writer enqueued once the wake that announced it reaches the owner', async () => {
        const nowMs = 10_000;
        const claimed: string[] = [];
        const queue = new InMemoryQueueBox();
        const port = createALWorkQueuePort({
            queue,
            workTypes: AL_TEST_TYPES,
            leaseMs: 30_000,
            nowMs: () => nowMs,
            random: () => 0.5
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'external-writer-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: () => readTestALWorkReadyAtMs(queue, AL_TEST_TYPES, nowMs),
            selectReady: async (claimable, size) => toTestALWorkReadySelection(await claimable.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                claimed.push(claim.entry.key.contextId);
                return { status: 'completed' };
            },
            diagnostics: undefined
        });

        await handler.ready();
        await engine.executeOnce();

        // Nobody's runtime wrote this: a server AppInbox transaction or a pub/sub requeue puts the
        // row in the queue and announces it with the engine's external-write wake alone.
        await queue.enqueue(newWorkEntry('AL_TEST', 'externally-written'));
        engine.wakeAfterExternalWrite();
        await engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(claimed).toEqual(['externally-written']);
        handler.dispose();
    });

    it('leaves the other owner on one engine its remembered answer when an owner wakes for itself', async () => {
        const nowMs = 10_000;
        const engine = createEngine();
        const probeCounts = { inbound: 0, outbound: 0 };
        const handlers = (['inbound', 'outbound'] as const).map((role) =>
            new ALWorkHandler({
                workerId: `${role}-owner`,
                port: fakePort({ claims: [], onRelease: () => {} }),
                queueEngine: engine,
                ownsQueueEngine: false,
                clock: { nowMs: () => nowMs },
                pageSize: 16,
                readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
                readNextReadyAtMs: async () => {
                    probeCounts[role] += 1;
                    return undefined;
                },
                selectReady: async () => toTestALWorkReadySelection([]),
                runClaim: async () => ({ status: 'completed' }),
                diagnostics: undefined
            })
        );
        for (const handler of handlers) {
            await handler.ready();
        }
        await engine.executeOnce();
        const afterBootstrap = { ...probeCounts };

        // The inbound owner's own progress: it reschedules the engine and announces nothing.
        engine.wake();
        await engine.executeOnce();

        // The outbound owner still answers from memory; only an external write costs it a read.
        expect(probeCounts.outbound).toBe(afterBootstrap.outbound);

        engine.wakeAfterExternalWrite();
        await engine.executeOnce();

        expect(probeCounts.outbound).toBeGreaterThan(afterBootstrap.outbound);
        for (const handler of handlers) {
            handler.dispose();
        }
    });

    it('turns a remembered ready time into a batch without reading storage again', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let nowMs = 10_000;
        let probeCount = 0;
        const port: ALWorkQueuePort = {
            ...fakePort({ claims: [], onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`) }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount)
        };
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'ready-at-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                probeCount += 1;
                return pending.length > 0 ? 10_500 : undefined;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        probeCount = 0;
        pending.push(toFakeALWorkClaim('later'));

        await engine.executeOnce();
        expect(probeCount).toBe(1);
        expect(released).toEqual([]);

        nowMs = 10_500;
        await engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(released).toEqual(['later:completed']);
        expect(probeCount).toBe(1);

        handler.dispose();
    });

    it('re-probes storage once the remembered answer reaches the idle bound', async () => {
        let nowMs = 10_000;
        let probeCount = 0;
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'aging-worker',
            port: fakePort({ claims: [], onRelease: () => {} }),
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                probeCount += 1;
                return undefined;
            },
            selectReady: async () => toTestALWorkReadySelection([]),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        probeCount = 0;

        await engine.executeOnce();
        expect(probeCount).toBe(1);

        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS - 1;
        await engine.executeOnce();
        expect(probeCount).toBe(1);

        // Work another tab wrote, or a lease a crashed owner left, is found on the engine's idle cadence.
        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS;
        await engine.executeOnce();
        expect(probeCount).toBe(2);

        handler.dispose();
    });

    it('owns a committed()-triggered corruption without an unhandled rejection, while ready() on a fresh handler still rejects', async () => {
        const port = fakePort({ claims: [], onRelease: () => {} });

        const freshHandler = new ALWorkHandler({
            workerId: 'bootstrap-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady: async () => {
                throw new ALAdmissionCorruptionError('bootstrap-path', new TypeError('bad admission state'));
            },
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });
        await expect(freshHandler.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        freshHandler.dispose();

        let shouldCorrupt = false;
        const selectReady = async (p: ALWorkQueuePort, size: number): Promise<ALWorkReadySelection> => {
            if (shouldCorrupt) {
                throw new ALAdmissionCorruptionError('committed-path', new TypeError('bad admission state'));
            }
            return toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined }));
        };
        const handler = new ALWorkHandler({
            workerId: 'committed-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => undefined,
            selectReady,
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        const unhandled: Error[] = [];
        const onUnhandledRejection: NodeJS.UnhandledRejectionListener = (reason) => {
            unhandled.push(toError(reason));
        };
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            await handler.ready();
            shouldCorrupt = true;
            handler.committed({ dueByMs: 1_000, dueNowCount: 0 });
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(unhandled).toEqual([]);
            expect(consoleErrorSpy).toHaveBeenCalledWith('ALM work batch failed', expect.any(ALAdmissionCorruptionError));
        }
        finally {
            process.off('unhandledRejection', onUnhandledRejection);
            consoleErrorSpy.mockRestore();
            handler.dispose();
        }
    });
});

interface RestoreFixture {
    readonly handler: ALWorkHandler;
    readonly engine: InboxOutboxEngine;
    readonly clock: { atMs: number; };
    /** What the next storage probe answers. */
    readonly storage: { readyAtMs: number | undefined; };
    readonly pending: ALWorkClaim[];
    readonly exhausted: ALWorkClaim[];
    readonly released: string[];
    readonly probes: ALWorkReadinessProbeDiagnostics[];
    /** Every time this owner handed the engine, in order. */
    readonly wakeAtCalls: (number | undefined)[];
}

/** What a claim may reach while it runs: the engine it shares and its own owner's commit. */
interface RestoreFixtureClaimScope {
    readonly engine: InboxOutboxEngine;
    readonly commit: () => void;
}

interface RestoreFixtureInput {
    readonly pageSize: number;
    readonly readinessMemoryMs: number;
    /** What storage probes answer until a test changes it. */
    readonly probedReadyAtMs: number | undefined;
    readonly runClaim: (claim: ALWorkClaim, scope: RestoreFixtureClaimScope) => Promise<ALWorkAttemptResult>;
}

interface UncleanBatchCase {
    readonly name: string;
    readonly pageSize: number;
    /** Rows the exhaustion sweep finalizes in the commit's batch. */
    readonly exhaustedRows: readonly string[];
    readonly runClaim: RestoreFixtureInput['runClaim'];
}

const UNCLEAN_BATCHES: readonly UncleanBatchCase[] = [
    { name: 'a retried claim', pageSize: 16, exhaustedRows: [], runClaim: async () => ({ status: 'retry' }) },
    {
        name: 'a claim not ready yet',
        pageSize: 16,
        exhaustedRows: [],
        runClaim: async () => ({ status: 'not-ready', readyAtMs: 11_000 })
    },
    {
        name: 'a retained claim',
        pageSize: 16,
        exhaustedRows: [],
        runClaim: async () => ({ status: 'retained', settled: new Promise<ALWorkOutcome>(() => {}) })
    },
    { name: 'a rejected claim', pageSize: 16, exhaustedRows: [], runClaim: async () => ({ status: 'non-retryable' }) },
    {
        name: 'an exhausted row the sweep finalized',
        pageSize: 16,
        exhaustedRows: ['exhausted-row'],
        runClaim: async () => ({ status: 'completed' })
    },
    { name: 'a full page', pageSize: 1, exhaustedRows: [], runClaim: async () => ({ status: 'completed' }) },
    {
        name: 'an external wake',
        pageSize: 16,
        exhaustedRows: [],
        runClaim: async (_claim, scope) => {
            scope.engine.wakeAfterExternalWrite();
            return { status: 'completed' };
        }
    },
    {
        name: 'a commit behind it',
        pageSize: 16,
        exhaustedRows: [],
        runClaim: async (_claim, scope) => {
            scope.commit();
            return { status: 'completed' };
        }
    }
];

function createRestoreFixture(input: RestoreFixtureInput): RestoreFixture {
    const engine = createEngine();
    const clock = { atMs: 10_000 };
    const storage = { readyAtMs: input.probedReadyAtMs };
    const pending: ALWorkClaim[] = [];
    const exhausted: ALWorkClaim[] = [];
    const released: string[] = [];
    const probes: ALWorkReadinessProbeDiagnostics[] = [];
    const wakeAtCalls: (number | undefined)[] = [];
    const wakeAt = engine.wakeAt.bind(engine);
    vi.spyOn(engine, 'wakeAt').mockImplementation((taskId, readyAtMs) => {
        wakeAtCalls.push(readyAtMs);
        wakeAt(taskId, readyAtMs);
    });
    const handler: ALWorkHandler = new ALWorkHandler({
        workerId: 'restore-worker',
        port: {
            ...fakePort({ claims: [], onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`) }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount),
            finalizeExhausted: async (maxCount) => exhausted.splice(0, maxCount)
        },
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => clock.atMs },
        pageSize: input.pageSize,
        readinessMemoryMs: input.readinessMemoryMs,
        readNextReadyAtMs: async () => storage.readyAtMs,
        selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
        runClaim: (claim) => input.runClaim(claim, { engine, commit: () => handler.committed({ dueByMs: clock.atMs, dueNowCount: 0 }) }),
        diagnostics: (event) => collectProbe(probes, event)
    });
    return { handler, engine, clock, storage, pending, exhausted, released, probes, wakeAtCalls };
}

/** One row this owner wrote, due now, and announced, and the batch its commit runs, to the end. */
async function commitRow(fixture: RestoreFixture, effectId: string): Promise<void> {
    await commitRowWriting(fixture, effectId, { dueByMs: fixture.clock.atMs, dueNowCount: 1 });
}

/** One row the queue hands the batch, from a commit that says it wrote `written`. */
async function commitRowWriting(
    fixture: RestoreFixture,
    effectId: string,
    written: ALWorkCommittedRows
): Promise<void> {
    fixture.pending.push(toFakeALWorkClaim(effectId));
    fixture.handler.committed(written);
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ALWorkHandler readiness restore', () => {
    it('restores the answer its commit suspended once a clean batch ends, at its own age, and hands its due time to the engine', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: 15_000,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory']);

        fixture.clock.atMs = 12_000;
        await commitRow(fixture, 'clean-row');
        expect(fixture.released).toEqual(['clean-row:completed']);
        // The selection advertised no time of its own, so the engine is handed the restored one.
        expect(fixture.wakeAtCalls.at(-1)).toBe(15_000);
        for (let round = 0; round < 25; round += 1) {
            await fixture.engine.executeOnce();
        }
        expect(fixture.probes).toHaveLength(1);

        // The answer was taken at 10 000, not when the batch restored it, so it ages out on time.
        fixture.clock.atMs = 10_000 + AL_WORK_READINESS_MEMORY_MS;
        await fixture.engine.executeOnce();
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'age-bound']);
        fixture.handler.dispose();
    });

    it.each(UNCLEAN_BATCHES)('probes after a batch with $name, naming the commit', async (unclean) => {
        const fixture = createRestoreFixture({
            pageSize: unclean.pageSize,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: unclean.runClaim
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();
        fixture.exhausted.push(...unclean.exhaustedRows.map((effectId) => toFakeALWorkClaim(effectId)));

        await commitRow(fixture, 'unclean-row');
        await fixture.engine.executeOnce();

        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
        fixture.handler.dispose();
    });

    it.each([
        { name: 'a row due only after its batch started', written: { dueByMs: 10_001, dueNowCount: 1 } },
        { name: 'work it cannot describe', written: AL_WORK_UNDESCRIBED_COMMIT }
    ])('probes after a clean batch whose commit wrote $name', async ({ written }) => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        // A receipted send writes its acknowledgement timeout beside the send: the batch completes the
        // send, and the timeout row it never saw is due later.
        await commitRowWriting(fixture, 'sent-row', written);
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual(['sent-row:completed']);
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
        fixture.handler.dispose();
    });

    it('probes after a clean batch that claimed none of the rows its commit made due', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        // The queue claims by its own clock, which lags this owner's: the commit's batch claims
        // nothing although the commit wrote a row due now, and the row appears to the next read.
        fixture.handler.committed({ dueByMs: fixture.clock.atMs, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fixture.released).toEqual([]);
        fixture.pending.push(toFakeALWorkClaim('lagging-row'));
        fixture.storage.readyAtMs = fixture.clock.atMs;
        await fixture.engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fixture.probes.map((probe) => [probe.cause, probe.readyAtMs])).toEqual([
            ['no-memory', 'none'],
            ['own-commit', 10_000]
        ]);
        expect(fixture.released).toEqual(['lagging-row:completed']);
        fixture.handler.dispose();
    });

    it('restores after a clean batch that claimed every row its commit made due at once, though the commit wrote more', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        // The commit dispatched at 10 000 and wrote one row due then and one due at 10 500; it hands
        // them over at 11 000, and the batch claims the one it made due at once.
        fixture.clock.atMs = 11_000;
        await commitRowWriting(fixture, 'due-row', { dueByMs: 10_500, dueNowCount: 1 });
        for (let round = 0; round < 25; round += 1) {
            await fixture.engine.executeOnce();
        }

        expect(fixture.released).toEqual(['due-row:completed']);
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory']);
        fixture.handler.dispose();
    });

    it('probes after a batch during which a claim an earlier batch retained released', async () => {
        let settleHeld: ((outcome: ALWorkOutcome) => void) | undefined;
        const held = new Promise<ALWorkOutcome>((resolve) => {
            settleHeld = resolve;
        });
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async (claim) => {
                if (claim.entry.key.contextId === 'held-row') {
                    return { status: 'retained', settled: held };
                }
                settleHeld?.({ status: 'completed' });
                await new Promise((resolve) => setTimeout(resolve, 0));
                return { status: 'completed' };
            }
        });
        await fixture.handler.ready();
        await commitRow(fixture, 'held-row');
        await fixture.engine.executeOnce();
        expect(fixture.probes).toHaveLength(1);

        await commitRow(fixture, 'releasing-row');
        await vi.waitFor(() => expect(fixture.released).toEqual(['held-row:completed', 'releasing-row:completed']));
        await fixture.engine.executeOnce();

        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
        fixture.handler.dispose();
    });

    it('probes after a clean batch whose suspended answer had come due before the batch started', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: 12_000,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();
        fixture.storage.readyAtMs = undefined;

        // Restoring a due answer would start a batch that claims nothing, on every engine round.
        fixture.clock.atMs = 12_000;
        await commitRow(fixture, 'late-row');
        await fixture.engine.executeOnce();

        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
        fixture.handler.dispose();
    });

    it('probes every round as before when its answers never stand, and hands the engine only the selection\'s time', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
            probedReadyAtMs: 15_000,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        await commitRow(fixture, 'inbound-row');
        expect(fixture.wakeAtCalls.at(-1)).toBeUndefined();
        for (let round = 0; round < 3; round += 1) {
            await fixture.engine.executeOnce();
        }

        expect(fixture.probes.map((probe) => probe.cause))
            .toEqual(['no-memory', 'own-commit', 'age-bound', 'age-bound']);
        fixture.handler.dispose();
    });

    it('finds a row another tab wrote, unannounced, once the restored answer reaches its age bound', async () => {
        let nowMs = 10_000;
        const claimed: string[] = [];
        const queue = new InMemoryQueueBox();
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'foreign-row-worker',
            port: createALWorkQueuePort({
                queue,
                workTypes: AL_TEST_TYPES,
                leaseMs: 30_000,
                nowMs: () => nowMs,
                random: () => 0.5
            }),
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => nowMs },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: () => readTestALWorkReadyAtMs(queue, AL_TEST_TYPES, nowMs),
            selectReady: async (claimable, size) => toTestALWorkReadySelection(await claimable.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async (claim) => {
                claimed.push(claim.entry.key.contextId);
                return { status: 'completed' };
            },
            diagnostics: undefined
        });
        await handler.ready();
        await engine.executeOnce();

        nowMs = 11_000;
        await queue.enqueue(newWorkEntry('AL_TEST', 'own-row'));
        handler.committed({ dueByMs: nowMs, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(claimed).toEqual(['own-row']);

        // No browser code announces another tab's write: the row reaches the queue and nothing else.
        await queue.enqueue(newWorkEntry('AL_TEST', 'foreign-row'));
        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS - 1;
        await engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(claimed).toEqual(['own-row']);

        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS;
        await engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(claimed).toEqual(['own-row', 'foreign-row']);
        handler.dispose();
    });
});

describe('ALWorkHandler readiness invalidation label', () => {
    it('names the probe after a discarded one with the invalidation that discarded it', async () => {
        const probes: ALWorkReadinessProbeDiagnostics[] = [];
        const pending: ALWorkClaim[] = [];
        let releaseProbe: (() => void) | undefined;
        let gateNextProbe = false;
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'discarded-probe-worker',
            port: { ...fakePort({ claims: [], onRelease: () => {} }), claim: async ({ maxCount }) => pending.splice(0, maxCount) },
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 10_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                if (gateNextProbe) {
                    gateNextProbe = false;
                    await new Promise<void>((resolve) => {
                        releaseProbe = resolve;
                    });
                }
                return undefined;
            },
            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: (event) => collectProbe(probes, event)
        });
        await handler.ready();
        await engine.executeOnce();

        engine.wakeAfterExternalWrite();
        gateNextProbe = true;
        const probing = engine.executeOnce();
        await vi.waitFor(() => expect(releaseProbe).toBeDefined());

        // The commit lands while the external wake's probe is reading: that answer is discarded, and
        // the commit, not the wake the discarded probe already reported, owes the next one.
        pending.push(toFakeALWorkClaim('mid-probe-row'));
        handler.committed({ dueByMs: 10_000, dueNowCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseProbe?.();
        await probing;
        await engine.executeOnce();

        expect(probes.map((probe) => probe.cause)).toEqual(['no-memory', 'external-wake', 'own-commit']);
        handler.dispose();
    });

    it('labels a probe no-memory once the probe before it took the invalidation and failed', async () => {
        const probes: ALWorkReadinessProbeDiagnostics[] = [];
        let failNextProbe = false;
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'failed-probe-worker',
            port: fakePort({ claims: [], onRelease: () => {} }),
            queueEngine: engine,
            ownsQueueEngine: false,
            clock: { nowMs: () => 10_000 },
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            readNextReadyAtMs: async () => {
                if (failNextProbe) {
                    failNextProbe = false;
                    throw new Error('storage unavailable');
                }
                return undefined;
            },
            selectReady: async () => toTestALWorkReadySelection([]),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: (event) => collectProbe(probes, event)
        });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await handler.ready();
            await engine.executeOnce();

            engine.wakeAfterExternalWrite();
            failNextProbe = true;
            await engine.executeOnce();
            await engine.executeOnce();

            // The failed read reported nothing, and the wake it answered is spent: the retry is no
            // wake's probe, only an owner with no answer at all.
            expect(probes.map((probe) => probe.cause)).toEqual(['no-memory', 'no-memory']);
        }
        finally {
            consoleErrorSpy.mockRestore();
            handler.dispose();
        }
    });
});

function collectProbe(probes: ALWorkReadinessProbeDiagnostics[], event: ALWorkDiagnostics): void {
    if (event.kind === 'readiness-probe') {
        probes.push(event);
    }
}

function createEngine(): InboxOutboxEngine {
    return new InboxOutboxEngine();
}

interface FakeALWorkPortInput {
    readonly claims: readonly string[];
    readonly onRelease: (claim: ALWorkClaim, outcome: ALWorkOutcome) => void;
    /** Effect ids returned once from finalizeExhausted, then drained to []. */
    readonly finalizeExhausted?: readonly string[];
}

function fakePort(input: FakeALWorkPortInput): ALWorkQueuePort {
    const pending = input.claims.map((effectId) => toFakeALWorkClaim(effectId));
    let exhausted = (input.finalizeExhausted ?? []).map((effectId) => toFakeALWorkClaim(effectId));
    return {
        retainIfAbsent: async (entry) => entry,
        readPage: async () => ({ entries: [], nextCursor: null }),
        readPages: async (inputs) => inputs.map(() => ({ entries: [], hasMoreEntries: false })),
        claim: async ({ maxCount }) => pending.splice(0, maxCount),
        finalizeExhausted: async () => {
            const claims = exhausted;
            exhausted = [];
            return claims;
        },
        releaseAll: async (releases) => {
            for (const release of releases) {
                input.onRelease(release.claim, release.outcome);
            }
        },
        readEntry: async () => undefined
    };
}

/** A port whose every flush is kept whole, so a pin can count the batches and read their order. */
function recordingPort(claims: readonly string[], flushes: ALWorkRelease[][]): ALWorkQueuePort {
    return {
        ...fakePort({ claims, onRelease: () => {} }),
        releaseAll: async (releases) => {
            if (releases.length > 0) {
                flushes.push([...releases]);
            }
        }
    };
}

function toFakeALWorkClaim(effectId: string): ALWorkClaim {
    return { entry: newWorkEntry('AL_TEST', effectId), attempts: 0, leaseUntilMs: 0 };
}
