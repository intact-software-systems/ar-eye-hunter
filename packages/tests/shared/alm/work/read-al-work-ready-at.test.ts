import { Temporal } from '@js-temporal/polyfill';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { computeALWorkEntry } from '@shared/alm/work/compute-al-work-entry.ts';
import { readALWorkReadyAt, type ReadALWorkReadyAtInput } from '@shared/alm/work/read-al-work-ready-at.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { describe, expect, it } from 'vitest';

const T = 1_000_000;
const LEASE_MS = 10_000;
const TYPE_ID = 'AL_TEST';

function createTestPort(): ALWorkQueuePort {
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(T));
    return createALWorkQueuePort({
        queue,
        workTypes: new Set([TYPE_ID]),
        leaseMs: LEASE_MS,
        nowMs: () => T,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
}

async function retainRow(port: ALWorkQueuePort, effectId: string, readyAtMs: number, expireAtTimestamp = T + 60_000) {
    await port.retainIfAbsent(computeALWorkEntry({
        key: { topicId: 'AL_TEST', resourceId: 'ns', contextId: effectId },
        typeId: TYPE_ID,
        resource: JSON.stringify({ effectId }),
        observedAtMs: T,
        readyAtMs,
        expireAtTimestamp
    }));
}

function toReadInput(input: Partial<ReadALWorkReadyAtInput> = {}): ReadALWorkReadyAtInput {
    return {
        nowMs: T,
        pageSize: 16,
        leaseMs: LEASE_MS,
        leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true },
        readHeldUntilMs: () => undefined,
        ...input
    };
}

describe('readALWorkReadyAt', () => {
    // A probe that answered the first row read rather than the earliest would wake its engine late.
    it('answers the earliest ready time of the new rows', async () => {
        const port = createTestPort();
        await retainRow(port, 'later', T + 5_000);
        await retainRow(port, 'earlier', T + 2_000);

        expect(await readALWorkReadyAt(port, toReadInput())).toBe(T + 2_000);
    });

    // An expired row is the queue's cleanup, not work: advertising it would wake the engine for nothing.
    it('answers nothing for an empty queue and for a row past its expiry', async () => {
        const empty = createTestPort();
        expect(await readALWorkReadyAt(empty, toReadInput())).toBeUndefined();

        const expired = createTestPort();
        await retainRow(expired, 'expired', T - 2_000, T - 1);
        expect(await readALWorkReadyAt(expired, toReadInput())).toBeUndefined();
    });

    // A closed sweep cannot recover the row, so advertising its lease end would start batches that claim nothing.
    it('answers a reserved row\'s lease end only while the timeout sweep may run', async () => {
        const port = createTestPort();
        await retainRow(port, 'claimed', T);
        await port.claim({ maxCount: 1, observedEntries: undefined });

        expect(await readALWorkReadyAt(port, toReadInput())).toBe(T + 10_000);
        expect(
            await readALWorkReadyAt(
                port,
                toReadInput({ leaseSweeps: { isTimeoutOpen: false, isFinalizationOpen: true } })
            )
        ).toBeUndefined();
    });

    // An owner's gate (the outbound dequeue breaker) must hold a row back, or the engine spins on work it refuses.
    it('holds a row to its owner\'s gate', async () => {
        const port = createTestPort();
        await retainRow(port, 'gated', T);

        expect(await readALWorkReadyAt(port, toReadInput({ readHeldUntilMs: () => T + 9_000 }))).toBe(T + 9_000);
    });

    // A truncated page may hide an earlier row, so a due row on a full page means work is due now, not at its own time.
    it('answers now when a full page holds a due row', async () => {
        const port = createTestPort();
        await retainRow(port, 'a', T - 1);
        await retainRow(port, 'b', T - 1);
        await retainRow(port, 'c', T - 1);

        expect(await readALWorkReadyAt(port, toReadInput({ pageSize: 2 }))).toBe(T);
    });
});
