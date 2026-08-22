import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import type { RtcRttMutationReceipt } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-contracts.ts';
import { DEFAULT_RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import {
    cleanupExpiredRtcRttReceipts,
    initRtcRttReceiptFamilyCleanup,
    RtcRttReceiptFamilyCleanupError
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
    RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-runtime-namespaces.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../fake-runtime-state-repository.ts';

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

    it('reads and validates the receipt before entering its write transaction', () => {
        const source = readFileSync(
            new URL(
                '../../../../../shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.ts',
                import.meta.url
            ),
            'utf8'
        );
        const cleanupStart = source.indexOf('async function cleanupExpiredRtcRttReceipt(');
        const writeStart = source.indexOf('async function deleteGuardedRtcRttReceipt(');
        const cleanupSection = source.slice(cleanupStart, writeStart);
        const writeSection = source.slice(writeStart);

        expect(cleanupSection.indexOf('probeMutationReceiptEntry(')).toBeGreaterThanOrEqual(0);
        expect(cleanupSection).not.toContain('runtime.begin(');
        expect(writeSection).toContain('runtime.begin(');
        expect(writeSection).not.toMatch(/\.findEntry|\.findEntriesByPrefix/);
        expect(writeSection.indexOf('.upsertIfRevision(')).toBeLessThan(
            writeSection.indexOf('.deleteIfRevision(')
        );
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
        const cancelled: unknown[] = [];
        const errors: unknown[] = [];
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
        const repository = new RtcRttRepository(new FakeRuntimeStateRepository(), { now: () => 1 });
        const failure = new Error('one corrupt family');
        let resolveSecond!: (removed: number) => void;
        const secondRun = new Promise<number>((resolve) => {
            resolveSecond = resolve;
        });
        const cleanup = vi
            .spyOn(repository, 'cleanupExpiredReceiptFamilies')
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce(() => secondRun);
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
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(scheduled).toHaveLength(1);

        resolveSecond(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduled).toHaveLength(2);
        handle.stop();
    });
});

async function createReceiptHarness(input: { readonly nowOffsetFromExpiry: number; }): Promise<
    Readonly<{
        runtime: FakeRuntimeStateRepository;
        repository: RtcRttRepository;
        receipt: RtcRttMutationReceipt;
        expireAtEpochMs: number;
    }>
> {
    const acceptedAtEpochMs = 1;
    const expireAtEpochMs = acceptedAtEpochMs + DEFAULT_RTC_RTT_MUTATION_RETENTION_MS;
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
