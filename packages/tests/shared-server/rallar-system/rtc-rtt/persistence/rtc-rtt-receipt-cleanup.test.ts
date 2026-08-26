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
import { describe, expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

interface RtcRttReceiptHarness {
    readonly runtime: FakeRuntimeStateRepository;
    readonly repository: RtcRttRepository;
    readonly receipt: RtcRttMutationReceipt;
    readonly expireAtEpochMs: number;
}

describe('RTC RTT receipt cleanup ownership', () => {
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
        await expect(
            harness.repository.probeMutationReceiptEntry(harness.receipt.receiptId)
        ).resolves.toBeDefined();
    });

    it('protects the receipt namespace from generic runtime expiry', () => {
        expect(RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES).toContain(RTC_RTT_RECEIPTS_NAMESPACE);
    });

    it('starts and stops periodic receipt-family cleanup on a non-evicting runtime', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new RtcRttRepository(runtimeRepository, {
            now: () => 1
        });
        const scheduled: Array<
            Readonly<{
                callback: () => void;
                delayMs: number;
                handle: object;
            }>
        > = [];
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
        const scheduled: Array<
            Readonly<{
                callback: () => void;
                handle: object;
            }>
        > = [];
        const handle = initRtcRttReceiptFamilyCleanup(repository, {
            intervalMs: 10,
            schedule: (callback) => {
                const timer = {};
                scheduled.push({ callback, handle: timer });
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
    const receipt = createReceipt(acceptedAtEpochMs);
    await runtime.insertIfAbsent(
        RTC_RTT_RECEIPTS_NAMESPACE,
        receipt.receiptId,
        JSON.stringify(receipt),
        expireAtEpochMs
    );
    return { runtime, repository, receipt, expireAtEpochMs };
}

function createReceipt(acceptedAtEpochMs: number): RtcRttMutationReceipt {
    const receiptId = toRtcRttMutationReceiptId({
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        version: 1
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
        measurementVersion: 1,
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
