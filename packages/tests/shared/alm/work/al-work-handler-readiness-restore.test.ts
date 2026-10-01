import type { ALWorkAttemptResult, ALWorkReadinessProbeDiagnostics } from '@shared/alm/work/al-work-handler.ts';
import { AL_WORK_PROBE_EVERY_ROUND, AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { ALWorkClaim, ALWorkOutcome } from '@shared/alm/work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    collectProbe,
    fakePort,
    newWorkEntry,
    readTestALWorkReadyAtMs,
    toFakeALWorkClaim,
    toTestALWorkReadySelection
} from './al-work-test-entries.ts';

const AL_TEST_TYPES: ReadonlySet<string> = new Set(['AL_TEST']);

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

/** What a claim may reach while it runs: the engine it shares, its own owner's commit, and its own writes. */
interface RestoreFixtureClaimScope {
    readonly engine: InboxOutboxEngine;
    readonly commit: () => void;
    readonly claimCommitted: () => void;
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
        name: 'a claim that committed work rows',
        pageSize: 16,
        exhaustedRows: [],
        runClaim: async (_claim, scope) => {
            scope.claimCommitted();
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
    const engine = new InboxOutboxEngine();
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
        runClaim: (claim) =>
            input.runClaim(claim, {
                engine,
                commit: () => handler.committed({ dueByMs: clock.atMs, writtenCount: 0 }),
                claimCommitted: () => handler.claimCommitted()
            }),
        diagnostics: (event) => collectProbe(probes, event)
    });
    return { handler, engine, clock, storage, pending, exhausted, released, probes, wakeAtCalls };
}

/** One row this owner wrote, due now, and announced, and the batch its commit runs, to the end. */
async function commitRow(fixture: RestoreFixture, effectId: string): Promise<void> {
    await commitRowWriting(fixture, effectId, { dueByMs: fixture.clock.atMs, writtenCount: 1 });
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
        { name: 'a row due only after its batch started', written: { dueByMs: 10_001, writtenCount: 1 } },
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

    it('probes after a clean batch that claimed none of the rows its commit wrote', async () => {
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
        fixture.handler.committed({ dueByMs: fixture.clock.atMs, writtenCount: 1 });
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

    it('probes after a clean batch that claimed fewer rows than its commit wrote, though all were due', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        // The commit dispatched at 10 000 and wrote one row due then and one due at 10 500; it hands
        // them over at 11 000, and the queue returns only the first to the batch.
        fixture.clock.atMs = 11_000;
        await commitRowWriting(fixture, 'due-row', { dueByMs: 10_500, writtenCount: 2 });
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual(['due-row:completed']);
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
        fixture.handler.dispose();
    });

    it('restores after a clean batch that claimed and completed every row its commit wrote', async () => {
        const fixture = createRestoreFixture({
            pageSize: 16,
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            probedReadyAtMs: undefined,
            runClaim: async () => ({ status: 'completed' })
        });
        await fixture.handler.ready();
        await fixture.engine.executeOnce();

        // Both rows the commit wrote were due by the time it handed them over, and the batch takes both.
        fixture.clock.atMs = 11_000;
        fixture.pending.push(toFakeALWorkClaim('first-row'));
        await commitRowWriting(fixture, 'second-row', { dueByMs: 10_500, writtenCount: 2 });
        for (let round = 0; round < 25; round += 1) {
            await fixture.engine.executeOnce();
        }

        expect(fixture.released).toEqual(['first-row:completed', 'second-row:completed']);
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
        const engine = new InboxOutboxEngine();
        const handler = new ALWorkHandler({
            workerId: 'foreign-row-worker',
            port: createALWorkQueuePort({
                queue,
                workTypes: AL_TEST_TYPES,
                leaseMs: 30_000,
                nowMs: () => nowMs,
                random: () => 0.5,
                leaseRecovery: { kind: 'every-batch' }
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
        handler.committed({ dueByMs: nowMs, writtenCount: 1 });
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
        const engine = new InboxOutboxEngine();
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
        handler.committed({ dueByMs: 10_000, writtenCount: 1 });
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
        const engine = new InboxOutboxEngine();
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
