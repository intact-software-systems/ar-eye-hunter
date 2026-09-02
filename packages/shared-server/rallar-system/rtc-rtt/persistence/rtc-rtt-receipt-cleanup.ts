import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import {
    assertRuntimeStateUpsertExpectedRevision,
    isRuntimeStateOptimisticTransactionalRepositoryLike,
    type RuntimeStateOptimisticTransactionalRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../topology/persistence/rtc-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../../topology/persistence/rtc-topology-identifiers.ts';
import type { RtcRttMutationReceipt } from './rtc-rtt-persistence-contracts.ts';
import type { RtcRttRepository } from './rtc-rtt-repository.ts';
import { RTC_RTT_RECEIPTS_NAMESPACE } from './rtc-rtt-runtime-namespaces.ts';

export const DEFAULT_RTC_RTT_RECEIPT_FAMILY_CLEANUP_INTERVAL_MS = 60_000;

export interface RtcRttReceiptFamilyCleanupHandle {
    readonly firstRun: Promise<number>;
    readonly stop: () => void;
}

export type RtcRttReceiptFamilyCleanupTimerHandle = object | number;

export interface RtcRttReceiptFamilyCleanupOptions {
    readonly intervalMs?: number;
    readonly schedule?: (callback: () => void, delayMs: number) => RtcRttReceiptFamilyCleanupTimerHandle;
    readonly cancel?: (handle: RtcRttReceiptFamilyCleanupTimerHandle) => void;
    readonly onError?: (error: Error) => void;
}

export interface RtcRttReceiptFamilyCleanupFailure {
    readonly familyId: string;
    readonly error: {
        readonly name: string;
        readonly message: string;
        readonly code?: string;
    };
}

export class RtcRttReceiptFamilyCleanupError extends RtcTopologyRepositoryInvariantCorruptionError {
    readonly removedCount: number;
    readonly failures: readonly RtcRttReceiptFamilyCleanupFailure[];

    constructor(removedCount: number, failures: readonly RtcRttReceiptFamilyCleanupFailure[]) {
        super(
            'rtc-rtt:receipt-family-cleanup',
            `RTC RTT receipt cleanup preserved ${failures.length} corrupt receipts ` +
                `after removing ${removedCount}`
        );
        this.removedCount = removedCount;
        this.failures = failures;
        this.name = 'RtcRttReceiptFamilyCleanupError';
    }
}

export async function cleanupExpiredRtcRttReceipts(repository: RtcRttRepository): Promise<number> {
    const observedAtEpochMs = repository.nowEpochMs();
    const entries = await repository.runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE);
    const candidateIds = entries
        .filter((entry) => entry.expireAtTimestamp <= observedAtEpochMs)
        .map((entry) => entry.key)
        .sort(compareRtcTopologyIdentifiers);
    let removedCount = 0;
    const failures: RtcRttReceiptFamilyCleanupFailure[] = [];

    for (const receiptId of candidateIds) {
        try {
            if (await cleanupExpiredRtcRttReceipt(repository, receiptId, observedAtEpochMs)) {
                removedCount += 1;
            }
        }
        catch (error) {
            failures.push({
                familyId: receiptId,
                error: toCleanupFailureError(
                    error instanceof Error ? error : new Error('RTC RTT receipt cleanup failed')
                )
            });
        }
    }
    if (failures.length > 0) {
        throw new RtcRttReceiptFamilyCleanupError(removedCount, failures);
    }
    return removedCount;
}

export function initRtcRttReceiptFamilyCleanup(
    repository: RtcRttRepository,
    options: RtcRttReceiptFamilyCleanupOptions = {}
): RtcRttReceiptFamilyCleanupHandle {
    const intervalMs = options.intervalMs ?? DEFAULT_RTC_RTT_RECEIPT_FAMILY_CLEANUP_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new RangeError('RTC RTT receipt cleanup interval is invalid');
    }
    const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const cancel = options.cancel ??
        ((handle: RtcRttReceiptFamilyCleanupTimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let stopped = false;
    let scheduledHandle: RtcRttReceiptFamilyCleanupTimerHandle | undefined;

    const run = async (surfaceFailure: boolean): Promise<number> => {
        try {
            return await repository.cleanupExpiredReceiptFamilies();
        }
        catch (error) {
            if (surfaceFailure) {
                throw error;
            }
            options.onError?.(
                error instanceof Error ? error : new Error('RTC RTT receipt cleanup failed')
            );
            return 0;
        }
        finally {
            if (!stopped) {
                scheduledHandle = schedule(() => {
                    void run(false);
                }, intervalMs);
            }
        }
    };

    const firstRun = run(true);
    return {
        firstRun,
        stop: () => {
            stopped = true;
            if (scheduledHandle !== undefined) {
                cancel(scheduledHandle);
                scheduledHandle = undefined;
            }
        }
    };
}

async function cleanupExpiredRtcRttReceipt(
    repository: RtcRttRepository,
    receiptId: string,
    observedAtEpochMs: number
): Promise<boolean> {
    const receipt = await repository.probeMutationReceiptEntry(receiptId);
    if (!receipt || receipt.entry.expireAtTimestamp > observedAtEpochMs) {
        return false;
    }
    return await deleteGuardedRtcRttReceipt(requireOptimisticRuntime(repository), receipt);
}

async function deleteGuardedRtcRttReceipt(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    receipt: RuntimeStateEntryValue<RtcRttMutationReceipt>
): Promise<boolean> {
    const expireAtIsoTimestamp = new Date(receipt.entry.expireAtTimestamp).toISOString();
    assertRuntimeStateUpsertExpectedRevision(receipt.entry.revision);
    return await runtime.begin(async (transaction) => {
        const guardedReceipt = await transaction.upsertIfRevision(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receipt.entry.key,
            receipt.entry.value,
            expireAtIsoTimestamp,
            receipt.entry.revision
        );
        if (guardedReceipt.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        const deletedReceipt = await transaction.deleteIfRevision(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receipt.entry.key,
            guardedReceipt.revision
        );
        if (deletedReceipt.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        return true;
    });
}

function requireOptimisticRuntime(
    repository: RtcRttRepository
): RuntimeStateOptimisticTransactionalRepositoryLike {
    const runtime = repository.runtimeRepository;
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC RTT receipt cleanup requires optimistic transactions');
    }
    return runtime;
}

function toCleanupFailureError(error: Error): RtcRttReceiptFamilyCleanupFailure['error'] {
    if (error instanceof RtcTopologyRepositoryInvariantCorruptionError) {
        return {
            name: error.name,
            message: 'RTC RTT receipt authority is corrupt',
            code: error.code
        };
    }
    if (error instanceof RuntimeStateWriteConflictError) {
        return {
            name: error.name,
            message: 'RTC RTT receipt cleanup lost its optimistic guard'
        };
    }
    return {
        name: error.name,
        message: 'RTC RTT receipt cleanup failed'
    };
}
