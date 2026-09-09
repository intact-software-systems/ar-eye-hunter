import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALWorkBatchDiagnostics, ALWorkReadySelection } from '@shared/alm/work/al-work-handler.ts';
import { ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it, vi } from 'vitest';
import { newWorkEntry } from './al-work-test-entries.ts';

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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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

    it('reports an active batch while a claim is in flight and clears it once ready() resolves', async () => {
        const port = fakePort({
            claims: ['slow-1'],
            onRelease: () => {}
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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

        expect(handler.hasActiveBatch()).toBe(false);
        const readyPromise = handler.ready();
        expect(handler.hasActiveBatch()).toBe(true);

        releaseClaim?.();
        await readyPromise;
        expect(handler.hasActiveBatch()).toBe(false);
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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

    it('starts a batch through the engine\'s isWork -> runnable path when peekNextReadyAt reports due work', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let dueAtMs: number | undefined;
        const port: ALWorkQueuePort = {
            workTypes: new Set(['AL_TEST']),
            retainIfAbsent: async (entry) => entry,
            readPage: async () => ({ entries: [], nextCursor: null }),
            claim: async ({ maxCount }) => pending.splice(0, maxCount),
            finalizeExhausted: async () => [],
            release: async (claim, outcome) => {
                released.push(`${claim.entry.key.contextId}:${outcome.status}`);
            },
            peekNextReadyAt: async () => {
                const next = dueAtMs;
                dueAtMs = undefined;
                return next;
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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
        // must discover it via peekNextReadyAt/wakeAt rather than the direct ready() bootstrap batch.
        pending.push(toFakeALWorkClaim('engine-driven'));
        dueAtMs = Date.now() - 1;

        await expect.poll(async () => {
            await engine.executeOnce();
            return released;
        }).toEqual(['engine-driven:completed']);

        handler.dispose();
    });

    it('drives readiness from the injected probe, not from the port', async () => {
        const released: string[] = [];
        const pending: ALWorkClaim[] = [];
        let peekCallCount = 0;
        const port = fakePort({
            claims: [],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const probing: ALWorkQueuePort = {
            ...port,
            claim: async ({ maxCount }) => pending.splice(0, maxCount),
            peekNextReadyAt: async () => {
                peekCallCount += 1;
                return undefined;
            }
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

        // The same probe reporting a due time starts the batch, through the engine alone.
        probedReadyAtMs = nowMs;
        await expect.poll(async () => {
            await engine.executeOnce();
            return released;
        }).toEqual(['later:completed']);
        expect(peekCallCount).toBe(0);

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
            workTypes: new Set(['AL_TEST']),
            retainIfAbsent: async (entry) => entry,
            readPage: async () => ({ entries: [], nextCursor: null }),
            claim: async ({ maxCount }) => {
                claimCallCount += 1;
                return pending.splice(0, maxCount);
            },
            finalizeExhausted: async () => [],
            release: async (claim, outcome) => {
                released.push(`${claim.entry.key.contextId}:${outcome.status}`);
            },
            peekNextReadyAt: async () => undefined,
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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
        expect(handler.hasActiveBatch()).toBe(false);
        claimCallCount = 0;

        // Seed the claim that a mid-batch commit must reach only through the follow-up batch: wait
        // for the claim() call of this batch to run and capture it before the second entry exists.
        pending.push(toFakeALWorkClaim('first'));
        handler.committed();
        expect(handler.hasActiveBatch()).toBe(true);
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

    it('owns a committed()-triggered corruption without an unhandled rejection, while ready() on a fresh handler still rejects', async () => {
        const port = fakePort({ claims: [], onRelease: () => {} });

        const freshHandler = new ALWorkHandler({
            workerId: 'bootstrap-worker',
            port,
            queueEngine: createEngine(),
            ownsQueueEngine: false,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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
            readNextReadyAtMs: (port) => port.peekNextReadyAt(),
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
        workTypes: new Set(['AL_TEST']),
        retainIfAbsent: async (entry) => entry,
        readPage: async () => ({ entries: [], nextCursor: null }),
        claim: async ({ maxCount }) => pending.splice(0, maxCount),
        finalizeExhausted: async () => {
            const claims = exhausted;
            exhausted = [];
            return claims;
        },
        release: async (claim, outcome) => {
            input.onRelease(claim, outcome);
        },
        peekNextReadyAt: async () => undefined,
        readEntry: async () => undefined
    };
}

function toFakeALWorkClaim(effectId: string): ALWorkClaim {
    return { entry: newWorkEntry('AL_TEST', effectId), attempts: 0, leaseUntilMs: 0 };
}
