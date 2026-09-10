import { Temporal } from '@js-temporal/polyfill';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALWorkBatchDiagnostics, ALWorkReadySelection } from '@shared/alm/work/al-work-handler.ts';
import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it, vi } from 'vitest';
import { newWorkEntry, readTestALWorkReadyAtMs } from './al-work-test-entries.ts';

const AL_TEST_TYPES: ReadonlySet<string> = new Set(['AL_TEST']);

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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async (claim) => claim.entry.key.contextId === 'w-2' ? { status: 'retry' } : { status: 'completed' },
            diagnostics: undefined
        });
        await handler.ready();
        expect(released).toEqual(['w-1:completed', 'w-2:retry']);

        const before = Date.now();
        handler.committed();
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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

        expect(released).toEqual(['c-1:non-retryable', 'c-2:retry', 'c-3:completed']);
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
        const diagnosticsEvents: ALWorkBatchDiagnostics[] = [];
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: (event) => diagnosticsEvents.push(event)
        });

        await handler.ready();

        expect(released).toEqual(['exhausted-1:non-retryable']);
        expect(diagnosticsEvents).toHaveLength(1);
        expect(diagnosticsEvents[0]).toMatchObject({
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 1
        });

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
            release: async (claim, outcome) => {
                released.push(`${claim.entry.key.contextId}:${outcome.status}`);
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
            release: async (claim, outcome) => {
                released.push(`${claim.entry.key.contextId}:${outcome.status}`);
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
        handler.committed();
        await firstClaimEntered;

        // A second commit lands, and its work becomes claimable, while the first entry is still in flight.
        pending.push(toFakeALWorkClaim('second'));
        handler.committed();

        releaseFirst?.();
        await expect.poll(() => released).toEqual(['first:completed', 'second:completed']);

        // Two distinct claim() calls after ready() prove the second entry arrived through the follow-up
        // batch that the finally block of runBatch() starts, not through the claim() call of the first batch.
        expect(claimCallCount).toBe(2);
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
                return { claims: [], nextReadyAtMs: undefined };
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
            selectReady: async (claimed, size) => ({
                claims: await claimed.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
                return { claims: [], nextReadyAtMs: readyAtMs };
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
            selectReady: async () => ({ claims: [], nextReadyAtMs: undefined }),
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

    it('re-probes storage after its own commit, and after a batch that claimed, exactly once each', async () => {
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async () => ({ status: 'completed' }),
            diagnostics: undefined
        });

        await handler.ready();
        probeCount = 0;
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(1);

        // A commit of this owner's own invalidates the answer; the batch it runs claims the row it wrote.
        pending.push(toFakeALWorkClaim('committed-row'));
        handler.committed();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(released).toEqual(['committed-row:completed']);
        expect(probeCount).toBe(1);

        // One probe re-establishes the answer the batch invalidated; the rounds after it read nothing.
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(2);

        // A batch the engine itself starts is worth exactly one probe to open it and one to close it.
        pending.push(toFakeALWorkClaim('engine-row'));
        handler.committed();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(released).toEqual(['committed-row:completed', 'engine-row:completed']);
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probeCount).toBe(3);

        handler.dispose();
    });

    it('re-probes storage when a retained claim settles after its own batch ended', async () => {
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async () => ({ status: 'retained', settled }),
            diagnostics: undefined
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

        handler.dispose();
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
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
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
            selectReady: async () => ({ claims: [], nextReadyAtMs: undefined }),
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
            return {
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            };
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
            handler.committed();
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
        release: async (claim, outcome) => {
            input.onRelease(claim, outcome);
        },
        readEntry: async () => undefined
    };
}

function toFakeALWorkClaim(effectId: string): ALWorkClaim {
    return { entry: newWorkEntry('AL_TEST', effectId), attempts: 0, leaseUntilMs: 0 };
}
