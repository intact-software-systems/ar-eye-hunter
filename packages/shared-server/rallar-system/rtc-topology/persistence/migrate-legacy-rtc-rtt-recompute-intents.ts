import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
// prettier-ignore
import * as snapshotValidation
    from '../../group-state/snapshot/validate-persisted-group-snapshot.ts';
import { groupStateGroupStorageKey } from '../../group-state-storage-keys.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { isRuntimeStateOptimisticTransactionalRepositoryLike }
    from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { RuntimeStateWriteConflictError }
    from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import type {
    JsonWireObject,
    JsonWireValue,
} from '../../services/mutation-command-identity.ts';
import type { RtcRttRecomputeIntent } from '../mutation/rtc-rtt-mutation-contracts.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../mutation/rtc-rtt-mutation-identifiers.ts';
import type { RtcRttMutationReceipt } from './rtc-rtt-persistence-contracts.ts';
import {
    validateRtcRttMeasurement,
    validateRtcRttMutationReceipt,
    validateRtcRttRecomputeIntent,
} from './rtc-rtt-persistence-validation.ts';
import type { RtcRttRepository } from './rtc-rtt-repository.ts';
import {
    RTC_RTT_RECEIPTS_NAMESPACE,
    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
} from './rtc-rtt-runtime-namespaces.ts';

type LegacyRtcRttRecomputeIntent = Pick<
    RtcRttRecomputeIntent,
    | 'outboxId'
    | 'receiptId'
    | 'groupSnapshot'
    | 'rtt'
    | 'createdAtEpochMs'
    | 'commandHash'
>;

export async function migrateLegacyRtcRttRecomputeIntents(
    repository: RtcRttRepository,
    options: Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error(
            'RTC RTT recompute intent migration requires old writers stopped',
        );
    }
    const runtime = requireOptimisticRuntime(repository.runtimeRepository);
    const sources = await runtime.findAllEntries(
        RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
    );
    for (const source of sources) {
        await runtime.begin(async (transaction) => {
            const current = await transaction.findEntry(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                source.key,
            );
            if (!current) return;
            const raw = parseValue(current);
            if (isRecord(raw) && Object.hasOwn(raw, 'delivery')) {
                validateCurrentIntent(current, raw);
                return;
            }
            const legacy = readLegacyIntent(current);
            const receiptEntry = await transaction.findEntry(
                RTC_RTT_RECEIPTS_NAMESPACE,
                legacy.receiptId,
            );
            if (!receiptEntry) {
                throw corruption(
                    current.key,
                    'Legacy RTC RTT recompute intent receipt is missing',
                );
            }
            const receipt = readReceipt(receiptEntry);
            if (
                receipt.receiptId !== receiptEntry.key ||
                receiptEntry.expireAtTimestamp !== current.expireAtTimestamp
            ) {
                throw corruption(
                    current.key,
                    'Legacy RTC RTT recompute intent family differs from receipt',
                );
            }
            const upgraded = {
                ...legacy,
                senderId: 'rallar-server-legacy-migration',
                delivery: { state: 'pending' },
            } as const satisfies RtcRttRecomputeIntent;
            validateRtcRttRecomputeIntent(upgraded, current.expireAtTimestamp);
            validateIntentAgainstReceipt(upgraded, receipt, current.key);
            const updated = await transaction.upsertIfRevision(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                current.key,
                JSON.stringify(upgraded),
                current.expireAtTimestamp,
                current.revision,
            );
            if (updated.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        });
    }
}

export {
    migrateLegacyRtcRttRecomputeIntents as migrateLegacyRtcRttRecomputeIntentDeliveryState,
};

function validateCurrentIntent(
    entry: RuntimeStateEntry,
    value: JsonWireObject,
): void {
    try {
        validateRtcRttRecomputeIntent(value, entry.expireAtTimestamp);
    } catch (error) {
        throw corruption(
            entry.key,
            error instanceof Error
                ? error.message
                : 'Invalid RTC RTT recompute intent',
        );
    }
}

function readReceipt(entry: RuntimeStateEntry): RtcRttMutationReceipt {
    try {
        const value = parseValue(entry);
        validateRtcRttMutationReceipt(value, entry.expireAtTimestamp);
        return value as RtcRttMutationReceipt;
    } catch (error) {
        throw corruption(
            entry.key,
            error instanceof Error ? error.message : 'Invalid RTC RTT receipt',
        );
    }
}

function readLegacyIntent(
    entry: RuntimeStateEntry,
): LegacyRtcRttRecomputeIntent {
    try {
        const value = parseValue(entry);
        if (!isRecord(value)) {
            throw new TypeError('Legacy RTC RTT recompute intent is invalid');
        }
        assertExactKeys(value, [
            'outboxId',
            'receiptId',
            'groupSnapshot',
            'rtt',
            'createdAtEpochMs',
            'commandHash',
        ]);
        validateLegacyIntent(value);
        return value as LegacyRtcRttRecomputeIntent;
    } catch (error) {
        throw corruption(
            entry.key,
            error instanceof Error
                ? error.message
                : 'Invalid legacy RTC RTT recompute intent',
        );
    }
}

function validateLegacyIntent(value: JsonWireObject): void {
    if (
        typeof value.outboxId !== 'string' ||
        value.outboxId.length === 0 ||
        typeof value.receiptId !== 'string' ||
        value.receiptId.length === 0 ||
        typeof value.createdAtEpochMs !== 'number' ||
        !Number.isSafeInteger(value.createdAtEpochMs) ||
        value.createdAtEpochMs < 0 ||
        typeof value.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(value.commandHash)
    ) {
        throw new TypeError('RTC RTT recompute intent fields are invalid');
    }
    snapshotValidation.validatePersistedGroupSnapshot(value.groupSnapshot);
    validateRtcRttMeasurement(value.rtt);
    const groupRef = (value.groupSnapshot as GroupSnapshot).group;
    const rtt = value.rtt as RttMeasurementInfo;
    const receiptId = toRtcRttMutationReceiptId(rtt);
    if (
        value.receiptId !== receiptId ||
        value.outboxId !==
            toRtcRttRecomputeOutboxId(receiptId, groupRef, value.commandHash)
    ) {
        throw new TypeError('RTC RTT recompute intent identity is invalid');
    }
}

function validateIntentAgainstReceipt(
    intent: RtcRttRecomputeIntent,
    receipt: RtcRttMutationReceipt,
    storageKey: string,
): void {
    const groupKey = groupStateGroupStorageKey(intent.groupSnapshot.group);
    const receiptIncludesGroup = receipt.affectedGroupRefs.some(
        (ref) => groupStateGroupStorageKey(ref) === groupKey,
    );
    const activeSessionIds = new Set(
        intent.groupSnapshot.activeSessions
            .filter(
                ({ connectedAtEpochMs, expiresAtEpochMs }) =>
                    connectedAtEpochMs <= intent.createdAtEpochMs &&
                    expiresAtEpochMs > intent.createdAtEpochMs,
            )
            .map(({ sessionId }) => sessionId),
    );
    const groupExpiry = intent.groupSnapshot.group.expiresAtEpochMs;
    if (
        receipt.receiptId !== intent.receiptId ||
        receipt.sessionIdFrom !== intent.rtt.sessionIdFrom ||
        receipt.sessionIdTo !== intent.rtt.sessionIdTo ||
        receipt.measurementVersion !== intent.rtt.version ||
        receipt.commandHash !== intent.commandHash ||
        receipt.acceptedAtEpochMs !== intent.createdAtEpochMs ||
        !receiptIncludesGroup ||
        intent.groupSnapshot.group.status !== 'active' ||
        (groupExpiry !== null && groupExpiry <= intent.createdAtEpochMs) ||
        !activeSessionIds.has(receipt.sessionIdFrom) ||
        !activeSessionIds.has(receipt.sessionIdTo)
    ) {
        throw corruption(
            storageKey,
            'RTC RTT recompute intent differs from immutable receipt authority',
        );
    }
}

function parseValue(entry: RuntimeStateEntry): JsonWireValue {
    try {
        return JSON.parse(entry.value) as JsonWireValue;
    } catch (error) {
        throw corruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC RTT JSON is invalid',
        );
    }
}

function assertExactKeys(
    value: JsonWireObject,
    keys: readonly string[],
): void {
    if (
        !rtcTopologySemanticEqual(Object.keys(value).sort(), [...keys].sort())
    ) {
        throw new TypeError('RTC RTT persisted value has invalid keys');
    }
}

function isRecord(value: JsonWireValue): value is JsonWireObject {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC RTT migration requires optimistic transactions');
    }
    return runtime;
}

function corruption(
    storageKey: string,
    message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(
        storageKey,
        message,
    );
}
