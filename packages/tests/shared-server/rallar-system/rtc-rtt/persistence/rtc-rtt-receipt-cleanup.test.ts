// dprint-ignore
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import type { RtcRttMutationReceipt } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-contracts.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-validation-primitives.ts';
import {
    cleanupExpiredRtcRttReceipts,
    initRtcRttReceiptFamilyCleanup,
    RtcRttReceiptFamilyCleanupError,
    type RtcRttReceiptFamilyCleanupTimerHandle
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-runtime-namespaces.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

interface RtcRttReceiptHarness {
    readonly runtime: FakeRuntimeStateRepository;
    readonly repository: RtcRttRepository;
    readonly receipt: RtcRttMutationReceipt;
    readonly expireAtEpochMs: number;
}

interface ScheduledRtcRttReceiptCleanup {
    readonly callback: () => void;
    readonly delayMs: number;
    readonly handle: object;
}

describe('RTC RTT receipt cleanup ownership', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([-1, -0, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
        'rejects original revision %s before entering a transaction and preserves the receipt',
        async (revision) => {
            const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
            const original = setReceiptStorageRevision(harness, revision);
            const transactionCount = observeTransactionCount(harness.runtime);

            await expect(cleanupExpiredRtcRttReceipts(harness.repository)).rejects.toMatchObject({
                name: 'RtcRttReceiptFamilyCleanupError',
                removedCount: 0,
                failures: [{
                    familyId: harness.receipt.receiptId,
                    error: { name: 'Error', message: 'RTC RTT receipt cleanup failed' }
                }]
            });

            expect(transactionCount()).toBe(0);
            await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId))
                .resolves.toEqual(original);
        }
    );

    it('accepts an update at MAX minus one and deletes with the resulting MAX revision', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
        setReceiptStorageRevision(harness, Number.MAX_SAFE_INTEGER - 1);
        const deleteIfRevision = harness.runtime.deleteIfRevision.bind(harness.runtime);
        const deletions: Parameters<typeof harness.runtime.deleteIfRevision>[] = [];
        vi.spyOn(harness.runtime, 'deleteIfRevision').mockImplementation(async (...args) => {
            deletions.push(args);
            return await deleteIfRevision(...args);
        });

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).resolves.toBe(1);

        expect(deletions).toEqual([
            [RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId, Number.MAX_SAFE_INTEGER]
        ]);
        await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId))
            .resolves.toBeUndefined();
    });

    it('deletes with the revision returned by the guard, not an independently calculated revision', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
        const upsertIfRevision = harness.runtime.upsertIfRevision.bind(harness.runtime);
        vi.spyOn(harness.runtime, 'upsertIfRevision').mockImplementationOnce(async (...args) => {
            const result = await upsertIfRevision(...args);
            if (result.status === 'conflict') {
                return result;
            }
            setReceiptStorageRevision(harness, 41);
            return { status: 'applied', revision: 41 };
        });

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).resolves.toBe(1);
        await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId))
            .resolves.toBeUndefined();
    });

    it('rolls back the guard when deletion conflicts and does not retry inside cleanup', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
        const original = setReceiptStorageRevision(harness, 0);
        const transactionCount = observeTransactionCount(harness.runtime);
        let deletionCount = 0;
        vi.spyOn(harness.runtime, 'deleteIfRevision').mockImplementation(async () => {
            deletionCount += 1;
            return { status: 'conflict' };
        });

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).rejects.toMatchObject({
            name: 'RtcRttReceiptFamilyCleanupError',
            removedCount: 0,
            failures: [{
                familyId: harness.receipt.receiptId,
                error: {
                    name: 'RuntimeStateWriteConflictError',
                    message: 'RTC RTT receipt cleanup lost its optimistic guard'
                }
            }]
        });

        expect(transactionCount()).toBe(1);
        expect(deletionCount).toBe(1);
        await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId))
            .resolves.toEqual(original);
    });

    it('aggregates invalid receipt failures while still deleting another expired receipt', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
        const original = setReceiptStorageRevision(harness, Number.MAX_SAFE_INTEGER);
        const validReceipt = createReceipt(1, 2);
        await harness.runtime.insertIfAbsent(
            RTC_RTT_RECEIPTS_NAMESPACE,
            validReceipt.receiptId,
            JSON.stringify(validReceipt),
            new Date(harness.expireAtEpochMs).toISOString()
        );
        const transactionCount = observeTransactionCount(harness.runtime);

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).rejects.toMatchObject({
            name: 'RtcRttReceiptFamilyCleanupError',
            removedCount: 1,
            failures: [{
                familyId: harness.receipt.receiptId,
                error: { name: 'Error', message: 'RTC RTT receipt cleanup failed' }
            }]
        });

        expect(transactionCount()).toBe(1);
        await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, harness.receipt.receiptId))
            .resolves.toEqual(original);
        await expect(harness.runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, validReceipt.receiptId))
            .resolves.toBeUndefined();
    });

    it('deletes an expired receipt', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).resolves.toBe(1);
        await expect(
            harness.repository.probeMutationReceiptEntry(harness.receipt.receiptId)
        ).resolves.toBeUndefined();
    });

    it('keeps a live receipt', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: -1 });

        await expect(cleanupExpiredRtcRttReceipts(harness.repository)).resolves.toBe(0);
        await expect(
            harness.repository.probeMutationReceiptEntry(harness.receipt.receiptId)
        ).resolves.toBeDefined();
    });

    it('preserves a receipt when its optimistic revision changes before deletion', async () => {
        const harness = await createReceiptHarness({ nowOffsetFromExpiry: 1 });
        const transactionCount = observeTransactionCount(harness.runtime);
        const deleteIfRevision = harness.runtime.deleteIfRevision.bind(harness.runtime);
        let deletionCount = 0;
        vi.spyOn(harness.runtime, 'deleteIfRevision').mockImplementation(async (...args) => {
            deletionCount += 1;
            return await deleteIfRevision(...args);
        });
        let changedRevision = false;
        harness.runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                !changedRevision &&
                operation === 'upsertIfRevision' &&
                namespace === RTC_RTT_RECEIPTS_NAMESPACE
            ) {
                changedRevision = true;
                await harness.runtime.upsert(
                    namespace,
                    key,
                    JSON.stringify(harness.receipt),
                    harness.expireAtEpochMs
                );
            }
        };

        const cleanup = cleanupExpiredRtcRttReceipts(harness.repository);
        await expect(cleanup).rejects.toBeInstanceOf(RtcRttReceiptFamilyCleanupError);
        expect(transactionCount()).toBe(1);
        expect(deletionCount).toBe(0);
        await expect(
            harness.repository.probeMutationReceiptEntry(harness.receipt.receiptId)
        ).resolves.toBeDefined();
    });

    it('declares the receipt namespace protected from generic runtime expiry', () => {
        expect(RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES).toContain(RTC_RTT_RECEIPTS_NAMESPACE);
    });

    it('starts and stops periodic receipt-family cleanup on a non-evicting runtime', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        const scheduled: ScheduledRtcRttReceiptCleanup[] = [];
        const cancelled: RtcRttReceiptFamilyCleanupTimerHandle[] = [];
        const errors: Error[] = [];
        const handle = initRtcRttReceiptFamilyCleanup(repository, {
            intervalMs: 123,
            schedule: (callback, delayMs) => {
                const timer = {};
                scheduled.push({ callback, delayMs, handle: timer });
                return timer;
            },
            cancel: (timer) => cancelled.push(timer),
            onError: (error) => errors.push(error)
        });

        await expect(handle.firstRun).resolves.toBe(0);
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]!.delayMs).toBe(123);
        expect(errors).toEqual([]);

        handle.stop();
        expect(cancelled).toEqual([scheduled[0]!.handle]);
    });

    it('continues periodic family cleanup after an error without overlapping runs', async () => {
        const failure = new Error('one corrupt family');
        const secondRun = Promise.withResolvers<number>();
        const repository = new SequencedCleanupRtcRttRepository(failure, secondRun.promise);
        const scheduled: ScheduledRtcRttReceiptCleanup[] = [];
        const handle = initRtcRttReceiptFamilyCleanup(repository, {
            intervalMs: 10,
            schedule: (callback, delayMs) => {
                const timer = {};
                scheduled.push({ callback, delayMs, handle: timer });
                return timer;
            },
            cancel: () => {}
        });

        await expect(handle.firstRun).rejects.toBe(failure);
        expect(scheduled).toHaveLength(1);
        scheduled[0]!.callback();
        await Promise.resolve();
        expect(scheduled).toHaveLength(1);

        secondRun.resolve(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduled).toHaveLength(2);
        handle.stop();
    });
});

function setReceiptStorageRevision(harness: RtcRttReceiptHarness, revision: number): RuntimeStateEntry {
    const storageKey = `${RTC_RTT_RECEIPTS_NAMESPACE}::${harness.receipt.receiptId}`;
    const current = harness.runtime.data.get(storageKey);
    if (current === undefined) {
        throw new Error('Expected a seeded RTC RTT receipt');
    }
    const entry = { ...current, revision };
    harness.runtime.data.set(storageKey, entry);
    return entry;
}

function observeTransactionCount(repository: FakeRuntimeStateRepository): () => number {
    const begin = repository.begin.bind(repository);
    let count = 0;
    vi.spyOn(repository, 'begin').mockImplementation(async (operation) => {
        count += 1;
        return await begin(operation);
    });
    return () => count;
}

class SequencedCleanupRtcRttRepository extends RtcRttRepository {
    private readonly firstFailure: Error;
    private readonly secondRun: Promise<number>;
    private runCount = 0;

    constructor(firstFailure: Error, secondRun: Promise<number>) {
        super(new FakeRuntimeStateRepository(), { now: () => 1 });
        this.firstFailure = firstFailure;
        this.secondRun = secondRun;
    }

    override cleanupExpiredReceiptFamilies(): Promise<number> {
        this.runCount += 1;
        if (this.runCount === 1) {
            return Promise.reject(this.firstFailure);
        }
        if (this.runCount === 2) {
            return this.secondRun;
        }
        return Promise.reject(new Error('Periodic cleanup overlapped an active run'));
    }
}

async function createReceiptHarness(
    input: Readonly<{ nowOffsetFromExpiry: number; }>
): Promise<RtcRttReceiptHarness> {
    const acceptedAtEpochMs = 1;
    const expireAtEpochMs = acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
    const runtime = new FakeRuntimeStateRepository();
    const repository = new RtcRttRepository(runtime, {
        now: () => expireAtEpochMs + input.nowOffsetFromExpiry
    });
    const receipt = createReceipt(acceptedAtEpochMs, 1);
    await runtime.insertIfAbsent(
        RTC_RTT_RECEIPTS_NAMESPACE,
        receipt.receiptId,
        JSON.stringify(receipt),
        new Date(expireAtEpochMs).toISOString()
    );
    return { runtime, repository, receipt, expireAtEpochMs };
}

function createReceipt(acceptedAtEpochMs: number, measurementVersion: number): RtcRttMutationReceipt {
    const receiptId = toRtcRttMutationReceiptId({
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        version: measurementVersion
    });
    return {
        receiptId,
        commandId: receiptId,
        requestId: receiptId,
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        aggregateRef: {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b'
        },
        measurementVersion,
        affectedGroupRefs: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            }
        ],
        acceptedAtEpochMs,
        outcome: 'accepted',
        attemptCount: 1,
        acceptedStorageRevision: 0,
        eventId: null,
        outboxIds: [],
        commandHash: `sha256:${'a'.repeat(64)}`
    };
}
