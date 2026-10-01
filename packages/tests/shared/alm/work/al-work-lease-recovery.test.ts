import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const START_MS = 1_700_000_000_000;
const DEQUEUE_TYPE = 'outbox';
const MESSAGE_TTL_MS = 120_000;
const ENGINE_PASS_MS = 100;
const BACKLOG_SIZE = 40;

interface LeaseRecoveryRun {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly queue: InMemoryQueueBox;
    readonly sent: string[];
    /** Every durable batch, at the lane clock when it ended. */
    readonly batchesAtMs: number[];
    readonly timeoutSweepsAtMs: number[];
    readonly finalizationSweepsAtMs: number[];
    /** Every sweep that returned a row, at the lane clock when it did. */
    readonly recoveredAtMs: number[];
    /** How many rows each of those sweeps returned. */
    readonly recoveredRowCounts: number[];
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('outbound lease recovery on the lane clock', () => {
    it('sweeps both on the bootstrap batch and neither on a send inside the window', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();

        expect(run.timeoutSweepsAtMs).toEqual([START_MS]);
        expect(run.finalizationSweepsAtMs).toEqual([START_MS]);

        await vi.advanceTimersByTimeAsync(1_000);
        await run.runtime.enqueueIfAbsent(createOutboundMessage('inside-the-window', { ttlMs: MESSAGE_TTL_MS }));
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.sent).toEqual(['inside-the-window']);
        expect(run.timeoutSweepsAtMs).toEqual([START_MS]);
        expect(run.finalizationSweepsAtMs).toEqual([START_MS]);
    });

    it('recovers a crashed lease within its lease end plus 19.1 s when a send spent the window just before', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'crashed', 1);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        // This send's batch sweeps a moment before the lease ends, so the window stays closed past it.
        await run.runtime.enqueueIfAbsent(createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS }));

        const recoveredAtMs = await advanceUntilRecovered(run);

        expect(run.timeoutSweepsAtMs.at(-2)).toBe(leaseEndMs - ENGINE_PASS_MS);
        expect(recoveredAtMs).toBeGreaterThan(leaseEndMs);
        expect(recoveredAtMs).toBeLessThanOrEqual(leaseEndMs + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
    });

    it('finalizes an exhausted reservation within its lease end plus 19.1 s when a send spent the window just before', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'exhausted', 20);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        await run.runtime.enqueueIfAbsent(createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS }));

        const recoveredAtMs = await advanceUntilRecovered(run);

        expect(run.finalizationSweepsAtMs.at(-2)).toBe(leaseEndMs - ENGINE_PASS_MS);
        expect(recoveredAtMs).toBeGreaterThan(leaseEndMs);
        expect(recoveredAtMs).toBeLessThanOrEqual(leaseEndMs + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
        expect((await run.queue.getItem(toCrashedKey('exhausted')))?.status).toBe(EntityStatus.NON_RETRYABLE);
    });

    it('runs no batch while a lease end waits for its closed window', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'crashed', 1);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        await run.runtime.enqueueIfAbsent(createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS }));
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        const batchesBefore = run.batchesAtMs.length;

        const recoveredAtMs = await advanceUntilRecovered(run);

        // The batch that recovers the lease is the only one the wait owed.
        expect(run.batchesAtMs.filter((atMs) => atMs > leaseEndMs && atMs < recoveredAtMs)).toEqual([]);
        expect(run.batchesAtMs.length - batchesBefore).toBeLessThanOrEqual(2);
    });

    it('recovers a backlog of crashed leases larger than one sweep within its lease end plus 19.1 s', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        let leaseEndMs = 0;
        for (let index = 0; index < BACKLOG_SIZE; index += 1) {
            leaseEndMs = await writeCrashedLease(run, `crashed-${String(index).padStart(2, '0')}`, 1);
        }
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        await run.runtime.enqueueIfAbsent(createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS }));

        const recoveredAtMs = await advanceUntilRecoveredRows(run, BACKLOG_SIZE);

        expect(recoveredAtMs).toBeLessThanOrEqual(leaseEndMs + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
        // A sweep that fills its room keeps the window open, so the backlog drains a page per batch, not per window.
        expect(run.recoveredRowCounts).toEqual([16, 16, 8]);
        expect(recoveredAtMs - run.recoveredAtMs[0]).toBeLessThan(ENGINE_PASS_MS);
    });

    it('recovers a crashed lease the readiness scan cannot see behind a full page of live leases', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        await writeCrashedLease(run, 'z-crashed', 1, Date.now() - AL_OUTBOUND_WORK_LEASE_MS - 1);
        for (let index = 0; index < 16; index += 1) {
            await writeCrashedLease(run, `a-live-${String(index).padStart(2, '0')}`, 1);
        }

        // The scan reads 16 reserved rows and the sweep 64: a send's batch reaches past the live page.
        await run.runtime.enqueueIfAbsent(createOutboundMessage('reaches-past-the-page', { ttlMs: MESSAGE_TTL_MS }));
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.recoveredAtMs).toEqual([START_MS + 13_000]);
        expect((await run.queue.getItem(toCrashedKey('z-crashed')))?.dequeueAudit.attempts).toBe(2);
    });

    it('spends the volatile lane\'s own window, never the durable lane\'s', async () => {
        const run = createLeaseRecoveryRun({ withVolatileLane: true });
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        await run.runtime.enqueueIfAbsent(createOutboundMessage('volatile-first', { ttlMs: MESSAGE_TTL_MS }));
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        const durableSweepsBefore = run.timeoutSweepsAtMs.length;

        await run.runtime.enqueueIfAbsent(createOutboundMessage('durable-after', { ttlMs: MESSAGE_TTL_MS }));
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.sent).toEqual(['volatile-first', 'durable-after']);
        expect(run.timeoutSweepsAtMs.length - durableSweepsBefore).toBe(1);
    });
});

function createLeaseRecoveryRun(options: { withVolatileLane?: boolean; } = {}): LeaseRecoveryRun {
    vi.useFakeTimers({ now: START_MS });
    // The engine's idle jitter at its widest, so the bound is measured at its worst.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
    const sent: string[] = [];
    const batchesAtMs: number[] = [];
    const sweeps = recordLeaseSweeps(queue);
    const runtime = createDefaultOutboundTestRuntime({
        outbox: queue,
        stores: createDefaultOutboundTestStores(queue),
        volatileStores: options.withVolatileLane === true
            ? createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload }, undefined)
            : undefined,
        dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDefaultALOutboundDequeueResilience() },
        diagnostics: (event) => {
            if (event.kind === 'effect-drain' && event.lane === 'durable') {
                batchesAtMs.push(Date.now());
            }
        },
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: msg.route.resourceId !== 'volatile-first',
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, queue, sent, batchesAtMs, ...sweeps };
}

function recordLeaseSweeps(
    queue: InMemoryQueueBox
): Pick<LeaseRecoveryRun, 'timeoutSweepsAtMs' | 'finalizationSweepsAtMs' | 'recoveredAtMs' | 'recoveredRowCounts'> {
    const recorded = {
        timeoutSweepsAtMs: [] as number[],
        finalizationSweepsAtMs: [] as number[],
        recoveredAtMs: [] as number[],
        recoveredRowCounts: [] as number[]
    };
    const reserveTimeouts = queue.reserveTimeoutEntries.bind(queue);
    vi.spyOn(queue, 'reserveTimeoutEntries').mockImplementation(async (request) => {
        recorded.timeoutSweepsAtMs.push(Date.now());
        const reserved = await reserveTimeouts(request);
        if (reserved.size > 0) {
            recorded.recoveredAtMs.push(Date.now());
            recorded.recoveredRowCounts.push(reserved.size);
        }
        return reserved;
    });
    const reserveFinalizations = queue.reserveRetryExhaustionFinalizations.bind(queue);
    vi.spyOn(queue, 'reserveRetryExhaustionFinalizations').mockImplementation(async (types, input) => {
        recorded.finalizationSweepsAtMs.push(Date.now());
        const reserved = await reserveFinalizations(types, input);
        if (reserved.size > 0) {
            recorded.recoveredAtMs.push(Date.now());
            recorded.recoveredRowCounts.push(reserved.size);
        }
        return reserved;
    });
    return recorded;
}

/** A dequeue row an owner reserved at `startMs` and never released, as a crashed owner leaves it; returns its lease end. */
async function writeCrashedLease(
    run: LeaseRecoveryRun,
    resourceId: string,
    attempts: number,
    startMs = Date.now()
): Promise<number> {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
        createOutboundMessage(resourceId, { ttlMs: MESSAGE_TTL_MS }),
        DEQUEUE_TYPE
    );
    await run.queue.enqueueIfAbsent(toReservedEntry(entry, startMs, attempts));
    return startMs + AL_OUTBOUND_WORK_LEASE_MS;
}

function toReservedEntry(entry: ResourceEntry, startMs: number, attempts: number): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: { ...entry.dequeueAudit, attempts, startTs: Temporal.Instant.fromEpochMilliseconds(startMs) }
    };
}

function toCrashedKey(resourceId: string) {
    return createOutboundMessage(resourceId).route;
}

async function advanceUntilRecovered(run: LeaseRecoveryRun): Promise<number> {
    const recoveredBefore = run.recoveredAtMs.length;
    for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += ENGINE_PASS_MS) {
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        if (run.recoveredAtMs.length > recoveredBefore) {
            return run.recoveredAtMs[recoveredBefore];
        }
    }
    throw new Error('Expected the lease to be recovered within a minute');
}

async function advanceUntilRecoveredRows(run: LeaseRecoveryRun, rowCount: number): Promise<number> {
    for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += ENGINE_PASS_MS) {
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        if (run.recoveredRowCounts.reduce((sum, count) => sum + count, 0) >= rowCount) {
            return run.recoveredAtMs[run.recoveredAtMs.length - 1];
        }
    }
    throw new Error(`Expected ${rowCount} leases to be recovered within a minute`);
}
