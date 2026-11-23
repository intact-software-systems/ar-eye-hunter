import { Temporal } from '@js-temporal/polyfill';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { computeALWorkEntry } from '@shared/alm/work/compute-al-work-entry.ts';
import {
    readALWorkReadyAt,
    resolveALWorkEntryDueAtMs,
    resolveALWorkEntryReadyAt,
    type ReadALWorkReadyAtInput
} from '@shared/alm/work/read-al-work-ready-at.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

const T = 1_000_000;
const LEASE_MS = 10_000;
const TYPE_ID = 'AL_TEST';
const OTHER_TYPE_ID = 'AL_OTHER';

function createTestPort(workTypes: ReadonlySet<string> = new Set([TYPE_ID])): ALWorkQueuePort {
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(T));
    return createALWorkQueuePort({
        queue,
        workTypes,
        leaseMs: LEASE_MS,
        nowMs: () => T,
        random: () => 0.5,
        leaseRecovery: { kind: 'every-batch' }
    });
}

interface TestRow {
    readonly effectId: string;
    readonly readyAtMs: number;
    readonly expireAtTimestamp?: number;
    readonly typeId?: string;
}

function toTestEntry(row: TestRow): ResourceEntry {
    return computeALWorkEntry({
        key: { topicId: 'AL_TEST', resourceId: 'ns', contextId: row.effectId },
        typeId: row.typeId ?? TYPE_ID,
        resource: JSON.stringify({ effectId: row.effectId }),
        observedAtMs: T,
        readyAtMs: row.readyAtMs,
        expireAtTimestamp: row.expireAtTimestamp ?? T + 60_000
    });
}

async function retainRow(port: ALWorkQueuePort, row: TestRow) {
    await port.retainIfAbsent(toTestEntry(row));
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
        await retainRow(port, { effectId: 'later', readyAtMs: T + 5_000 });
        await retainRow(port, { effectId: 'earlier', readyAtMs: T + 2_000 });

        expect(await readALWorkReadyAt(port, toReadInput())).toBe(T + 2_000);
    });

    // An expired row is the queue's cleanup, not work: advertising it would wake the engine for nothing.
    it('answers nothing for an empty queue and for a row past its expiry', async () => {
        const empty = createTestPort();
        expect(await readALWorkReadyAt(empty, toReadInput())).toBeUndefined();

        const expired = createTestPort();
        await retainRow(expired, { effectId: 'expired', readyAtMs: T - 2_000, expireAtTimestamp: T - 1 });
        expect(await readALWorkReadyAt(expired, toReadInput())).toBeUndefined();
    });

    // A closed sweep cannot recover the row, so advertising its lease end would start batches that claim nothing.
    it('answers a reserved row\'s lease end only while the timeout sweep may run', async () => {
        const port = createTestPort();
        await retainRow(port, { effectId: 'claimed', readyAtMs: T });
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
        await retainRow(port, { effectId: 'gated', readyAtMs: T });

        expect(await readALWorkReadyAt(port, toReadInput({ readHeldUntilMs: () => T + 9_000 }))).toBe(T + 9_000);
    });

    // A gate that held every type's rows would delay ungated work behind another type's breaker.
    it('holds only the rows of the type its gate names', async () => {
        const port = createTestPort(new Set([TYPE_ID, OTHER_TYPE_ID]));
        await retainRow(port, { effectId: 'gated', readyAtMs: T });
        await retainRow(port, { effectId: 'free', readyAtMs: T + 1_000, typeId: OTHER_TYPE_ID });

        const readHeldUntilMs = (entry: ResourceEntry) => entry.typeId === TYPE_ID ? T + 9_000 : undefined;
        expect(await readALWorkReadyAt(port, toReadInput({ readHeldUntilMs }))).toBe(T + 1_000);
    });

    // A truncated page may hide an earlier row, so a due row on a full page means work is due now, not at its own time.
    it('answers now when a full page holds a due row', async () => {
        const port = createTestPort();
        await retainRow(port, { effectId: 'a', readyAtMs: T - 1 });
        await retainRow(port, { effectId: 'b', readyAtMs: T - 1 });
        await retainRow(port, { effectId: 'c', readyAtMs: T - 1 });

        expect(await readALWorkReadyAt(port, toReadInput({ pageSize: 2 }))).toBe(T);
    });
});

describe('resolveALWorkEntryDueAtMs', () => {
    // A row is due at its retry stamp; one whose stamp was cleared (a reservation clears it) is due when it was written.
    it('answers the row\'s next time, else its creation time', () => {
        const entry = toTestEntry({ effectId: 'due', readyAtMs: T + 4_000 });
        expect(resolveALWorkEntryDueAtMs(entry)).toBe(T + 4_000);

        const unstamped = { ...entry, dequeueAudit: { ...entry.dequeueAudit, nextTs: undefined } };
        expect(resolveALWorkEntryDueAtMs(unstamped)).toBe(T);
    });
});

describe('resolveALWorkEntryReadyAt', () => {
    // A reserved row without its start is corrupt for every owner: a retryable error would loop on it forever.
    it('refuses a reserved row with no reservation start as non-retryable', () => {
        const entry = toTestEntry({ effectId: 'corrupt', readyAtMs: T });
        const reserved = { ...entry, status: EntityStatus.RESERVED };

        expect(() => resolveALWorkEntryReadyAt(reserved, LEASE_MS)).toThrow(NonRetryableException);
    });
});
