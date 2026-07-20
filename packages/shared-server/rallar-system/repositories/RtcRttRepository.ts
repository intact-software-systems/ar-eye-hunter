import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import type {
    RtcRttEndpointAdmission,
    RtcRttMutationLifecycleFacts,
    RtcRttMutationReceipt,
    RtcRttRecomputeIntent,
} from '../services/rtc-topology-mutations.ts';
import { validatePersistedGroupSnapshot } from '../services/group-snapshot-validation.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    RTC_RTT_MUTATION_RETENTION_MS,
    validateRtcRttEndpointAdmissionCandidateVersion,
    validateRtcRttEndpointAdmissionPersistedVersion,
    validateRtcRttEndpointAdmission as validatePersistedRtcRttEndpointAdmission,
    validateRtcRttMeasurement as validatePersistedRtcRttMeasurement,
    validateRtcRttMutationReceipt as validatePersistedRtcRttMutationReceipt,
    validateRtcRttRecomputeIntent as validatePersistedRtcRttRecomputeIntent,
} from '../rtc-rtt-persistence-validation.ts';

export {
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../rtc-topology-identifiers.ts';

export const RTC_RTT_LATEST_NAMESPACE = 'rtc-rtt:latest';
export const RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE = 'rtc-rtt:endpoint-admission';
export const RTC_RTT_RECEIPTS_NAMESPACE = 'rtc-rtt:receipts';
export const RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE = 'rtc-rtt:recompute-outbox';
export const RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES = [
    RTC_RTT_RECEIPTS_NAMESPACE,
    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
] as const;
export const DEFAULT_RTC_RTT_MUTATION_RETENTION_MS =
    RTC_RTT_MUTATION_RETENTION_MS;
export const DEFAULT_RTC_RTT_RECEIPT_FAMILY_CLEANUP_INTERVAL_MS = 60_000;

const DEFAULT_RTC_RTT_TTL_MS = 60_000;

export type RtcRttRepositoryOptions = Readonly<{
    ttlMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>;

export type RtcRttConditionalWriteResult =
    | Readonly<{ status: 'accepted'; storageRevision: number }>
    | Readonly<{ status: 'conflict' }>;

export type RtcRttReceiptFamilyCleanupHandle = Readonly<{
    firstRun: Promise<number>;
    stop(): void;
}>;

export type RtcRttReceiptFamilyCleanupOptions = Readonly<{
    intervalMs?: number;
    schedule?: (callback: () => void, delayMs: number) => unknown;
    cancel?: (handle: unknown) => void;
    onError?: (error: unknown) => void;
}>;

export type RtcRttReceiptFamilyCleanupFailure = Readonly<{
    familyId: string;
    error: Readonly<{
        name: string;
        message: string;
        code?: string;
    }>;
}>;

export class RtcRttReceiptFamilyCleanupError
    extends RtcTopologyRepositoryInvariantCorruptionError {
    constructor(
        readonly removedCount: number,
        readonly failures: readonly RtcRttReceiptFamilyCleanupFailure[],
    ) {
        super(
            'rtc-rtt:receipt-family-cleanup',
            `RTC RTT receipt family cleanup preserved ${failures.length} corrupt families after removing ${removedCount}`,
        );
        this.name = 'RtcRttReceiptFamilyCleanupError';
    }
}

type RtcRttReceiptFamilySweepCandidate = Readonly<{
    familyId: string;
    malformedIntentKey?: string;
}>;

type RtcRttReceiptFamilyCleanupRead = Readonly<{
    receiptId: string;
    receiptEntry: RuntimeStateEntry | undefined;
    siblingEntries: readonly RuntimeStateEntry[];
}>;

type RtcRttReceiptFamilyCleanupPlan =
    | Readonly<{ outcome: 'absent' }>
    | Readonly<{
        outcome: 'delete';
        receipt: RuntimeStateEntryValue<RtcRttMutationReceipt>;
        siblings: readonly RuntimeStateEntryValue<RtcRttRecomputeIntent>[];
    }>;

export class RtcRttRepository extends RuntimeStateJsonStore {
    constructor(
        readonly runtimeRepository: RuntimeStateRepositoryLike,
        private readonly options: RtcRttRepositoryOptions = {},
    ) {
        super(runtimeRepository);
    }

    async findMeasurementEntry(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<RuntimeStateEntryValue<RttMeasurementInfo> | undefined> {
        const key = this.measurementKey(sessionIdA, sessionIdB);
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_LATEST_NAMESPACE,
            key,
        );
        return entry
            ? await this.toLiveMeasurementEntry(entry, sessionIdA, sessionIdB)
            : undefined;
    }

    async findMeasurement(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<RttMeasurementInfo | undefined> {
        return (await this.findMeasurementEntry(sessionIdA, sessionIdB))?.value;
    }

    async listMeasurementEntries(): Promise<
        readonly RuntimeStateEntryValue<RttMeasurementInfo>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_RTT_LATEST_NAMESPACE,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveMeasurementEntry(entry)
        )));
    }

    async listMeasurementEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RttMeasurementInfo>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_LATEST_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveMeasurementEntry(entry)
        )));
    }

    async listMeasurements(): Promise<readonly RttMeasurementInfo[]> {
        return (await this.listMeasurementEntries()).map(({ value }) => value);
    }

    async listMeasurementsForSessionIds(
        sessionIds: readonly string[],
    ): Promise<readonly RttMeasurementInfo[]> {
        const sessionSet = new Set(sessionIds);
        return (await this.listMeasurements()).filter((measurement) =>
            sessionSet.has(measurement.sessionIdFrom) &&
            sessionSet.has(measurement.sessionIdTo)
        );
    }

    async findEndpointAdmissionEntry(
        endpointId: string,
    ): Promise<RuntimeStateEntryValue<RtcRttEndpointAdmission> | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            this.endpointAdmissionKey(endpointId),
        );
        return entry
            ? await this.toLiveEndpointAdmissionEntry(entry, endpointId)
            : undefined;
    }

    async listEndpointAdmissionEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveEndpointAdmissionEntry(entry)
        )));
    }

    async listEndpointAdmissionEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveEndpointAdmissionEntry(entry)
        )));
    }

    async commitMeasurement(
        measurement: RttMeasurementInfo,
        expectedRevision: number | null,
        purgeAfterEpochMs: number,
    ): Promise<RtcRttConditionalWriteResult> {
        validateMeasurement(measurement);
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                RTC_RTT_LATEST_NAMESPACE,
                this.measurementKey(
                    measurement.sessionIdFrom,
                    measurement.sessionIdTo,
                ),
                measurement,
                purgeAfterEpochMs,
            )
            : await this.putValueIfRevision(
                RTC_RTT_LATEST_NAMESPACE,
                this.measurementKey(
                    measurement.sessionIdFrom,
                    measurement.sessionIdTo,
                ),
                measurement,
                purgeAfterEpochMs,
                expectedRevision,
            );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async commitEndpointAdmission(
        admission: RtcRttEndpointAdmission,
        expectedRevision: number | null,
        expireAtTimestamp: number,
    ): Promise<RtcRttConditionalWriteResult> {
        validateEndpointAdmission(admission, admission.endpointId, expireAtTimestamp);
        validateRtcRttEndpointAdmissionCandidateVersion(
            admission.version,
            expectedRevision,
        );
        const result = expectedRevision === null
            ? await this.putValueIfAbsent(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                this.endpointAdmissionKey(admission.endpointId),
                admission,
                expireAtTimestamp,
            )
            : await this.putValueIfRevision(
                RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                this.endpointAdmissionKey(admission.endpointId),
                admission,
                expireAtTimestamp,
                expectedRevision,
            );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async insertMutationReceipt(
        receipt: RtcRttMutationReceipt,
        expireAtTimestamp: number,
    ): Promise<RtcRttConditionalWriteResult> {
        validateMutationReceipt(receipt);
        validateMutationReceiptPhysicalExpiry(receipt, expireAtTimestamp);
        const result = await this.putValueIfAbsent(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receipt.receiptId,
            receipt,
            expireAtTimestamp,
        );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async insertRecomputeIntent(
        intent: RtcRttRecomputeIntent,
        expireAtTimestamp: number,
    ): Promise<RtcRttConditionalWriteResult> {
        validateRecomputeIntent(intent, expireAtTimestamp);
        const result = await this.putValueIfAbsent(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            intent.outboxId,
            intent,
            expireAtTimestamp,
        );
        return result.status === 'applied'
            ? { status: 'accepted', storageRevision: result.revision }
            : { status: 'conflict' };
    }

    async findMutationReceipt(
        receiptId: string,
    ): Promise<RtcRttMutationReceipt | undefined> {
        return (await this.findMutationReceiptEntry(receiptId))?.value;
    }

    /**
     * Immutable idempotency authority probe. A physically retained receipt is
     * authoritative until a separate lifecycle-aware cleanup removes it.
     */
    async probeMutationReceiptEntry(
        receiptId: string,
    ): Promise<RuntimeStateEntryValue<RtcRttMutationReceipt> | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_RECEIPTS_NAMESPACE,
            receiptId,
        );
        if (!entry) return undefined;
        try {
            return this.toReceiptEntry(entry, receiptId);
        } catch (error) {
            throw rttCorruption(
                entry.key,
                error instanceof Error ? error.message : 'Invalid RTT receipt',
            );
        }
    }

    async findMutationReceiptEntry(
        receiptId: string,
    ): Promise<RuntimeStateEntryValue<RtcRttMutationReceipt> | undefined> {
        const receipt = await this.probeMutationReceiptEntry(receiptId);
        return receipt && receipt.entry.expireAtTimestamp > this.nowEpochMs()
            ? receipt
            : undefined;
    }

    async listMutationReceiptEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcRttMutationReceipt>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_RTT_RECEIPTS_NAMESPACE,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveReceiptEntry(entry)
        )));
    }

    async listMutationReceiptEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcRttMutationReceipt>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_RECEIPTS_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveReceiptEntry(entry)
        )));
    }

    async listRecomputeIntents(): Promise<readonly RtcRttRecomputeIntent[]> {
        return (await this.listRecomputeIntentEntries()).map(({ value }) => value);
    }

    async markRecomputeIntentDelivered(
        observed: RuntimeStateEntryValue<RtcRttRecomputeIntent>,
        deliveredAtEpochMs: number,
    ): Promise<Readonly<{ status: 'accepted' | 'conflict' }>> {
        const intent = this.toRecomputeIntentEntry(
            observed.entry,
            observed.value.outboxId,
        );
        if (intent.value.delivery.state !== 'pending') {
            throw rttCorruption(
                intent.entry.key,
                'RTC RTT recompute intent is already delivered',
            );
        }
        if (
            !Number.isSafeInteger(deliveredAtEpochMs) ||
            deliveredAtEpochMs < intent.value.createdAtEpochMs ||
            deliveredAtEpochMs > intent.entry.expireAtTimestamp
        ) {
            throw rttCorruption(
                intent.entry.key,
                'RTC RTT recompute delivery time is outside the retained family lifetime',
            );
        }
        const conditional = requireConditionalRuntime(this.runtimeRepository);
        const updated = await conditional.upsertIfRevision(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            intent.entry.key,
            JSON.stringify({
                ...intent.value,
                delivery: {
                    state: 'delivered',
                    deliveredAtEpochMs,
                },
            } satisfies RtcRttRecomputeIntent),
            intent.entry.expireAtTimestamp,
            intent.entry.revision,
        );
        return updated.status === 'applied'
            ? { status: 'accepted' }
            : { status: 'conflict' };
    }

    async listRecomputeIntentEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcRttRecomputeIntent>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
        );
        return compact(await Promise.all(entries.map(async (entry) => {
            return await this.toLiveRecomputeIntentEntry(entry);
        })));
    }

    async findRecomputeIntentEntry(
        outboxId: string,
    ): Promise<RuntimeStateEntryValue<RtcRttRecomputeIntent> | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            outboxId,
        );
        return entry
            ? await this.toLiveRecomputeIntentEntry(entry, outboxId)
            : undefined;
    }

    async listRecomputeIntentEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcRttRecomputeIntent>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveRecomputeIntentEntry(entry)
        )));
    }

    async putMeasurementIfNewer(
        measurement: RttMeasurementInfo,
        purgeAfterEpochMs: number = this.defaultPurgeAfterEpochMs(),
    ): Promise<boolean> {
        // Compatibility seam with explicit single-attempt optimistic semantics:
        // accepted=true, exact duplicate/strictly stale=false, CAS race=typed
        // conflict, and equal-version divergent content=fail-closed corruption.
        const current = await this.findMeasurementEntry(
            measurement.sessionIdFrom,
            measurement.sessionIdTo,
        );
        if (current && current.value.version === measurement.version) {
            if (!sameMeasurement(current.value, measurement)) {
                throw rttCorruption(
                    current.entry.key,
                    'RTC RTT equal version differs from durable measurement',
                );
            }
            return false;
        }
        if (current && current.value.version > measurement.version) return false;
        const result = await this.commitMeasurement(
            measurement,
            current?.entry.revision ?? null,
            purgeAfterEpochMs,
        );
        if (result.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        return true;
    }

    async removeMeasurement(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<void> {
        const current = await this.findMeasurementEntry(sessionIdA, sessionIdB);
        if (!current) return;
        await this.deleteValueIfRevision(
            RTC_RTT_LATEST_NAMESPACE,
            this.measurementKey(sessionIdA, sessionIdB),
            current.entry.revision,
        );
    }

    measurementKey(sessionIdA: string, sessionIdB: string): string {
        const [from, to] = sortedPair(sessionIdA, sessionIdB);
        return `from=${encodeURIComponent(from)}:to=${encodeURIComponent(to)}`;
    }

    endpointAdmissionKey(endpointId: string): string {
        return `endpoint=${encodeURIComponent(endpointId)}`;
    }

    defaultPurgeAfterEpochMs(): number {
        return this.nowEpochMs() + (this.options.ttlMs ?? DEFAULT_RTC_RTT_TTL_MS);
    }

    readMutationFacts(): RtcRttMutationLifecycleFacts {
        const requestedAtEpochMs = this.nowEpochMs();
        return {
            requestedAtEpochMs,
            purgeAfterEpochMs: requestedAtEpochMs +
                (this.options.ttlMs ?? DEFAULT_RTC_RTT_TTL_MS),
        };
    }

    nowEpochMs(): number {
        return this.options.now?.() ?? Date.now();
    }

    async cleanupExpiredReceiptFamilies(): Promise<number> {
        const observedAtEpochMs = this.nowEpochMs();
        const [receiptEntries, intentEntries] = await Promise.all([
            this.runtimeRepository.findAllEntries(RTC_RTT_RECEIPTS_NAMESPACE),
            this.runtimeRepository.findAllEntries(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
            ),
        ]);
        const candidates = new Map<string, RtcRttReceiptFamilySweepCandidate>();
        for (const entry of receiptEntries) {
            if (entry.expireAtTimestamp <= observedAtEpochMs) {
                candidates.set(entry.key, { familyId: entry.key });
            }
        }
        for (const entry of intentEntries) {
            if (entry.expireAtTimestamp > observedAtEpochMs) continue;
            const markerIndex = entry.key.indexOf(':commandHash=');
            if (markerIndex <= 0) {
                candidates.set(entry.key, {
                    familyId: entry.key,
                    malformedIntentKey: entry.key,
                });
                continue;
            }
            const familyId = entry.key.slice(0, markerIndex);
            if (!candidates.has(familyId)) {
                candidates.set(familyId, { familyId });
            }
        }
        let removed = 0;
        const failures: RtcRttReceiptFamilyCleanupFailure[] = [];
        const orderedCandidates = [...candidates.values()].sort((left, right) =>
            compareRtcTopologyIdentifiers(left.familyId, right.familyId)
        );
        for (const candidate of orderedCandidates) {
            try {
                if (candidate.malformedIntentKey !== undefined) {
                    throw rttCorruption(
                        candidate.malformedIntentKey,
                        'RTC RTT recompute intent physical key has invalid shape',
                    );
                }
                if (await this.cleanupExpiredReceiptFamily(
                    candidate.familyId,
                    observedAtEpochMs,
                    0,
                )) {
                    removed += 1;
                }
            } catch (error) {
                failures.push({
                    familyId: candidate.familyId,
                    error: toCleanupFailureError(error),
                });
            }
        }
        if (failures.length > 0) {
            throw new RtcRttReceiptFamilyCleanupError(removed, failures);
        }
        return removed;
    }

    private async toLiveMeasurementEntry(
        entry: RuntimeStateEntry,
        trustedSessionIdA?: string,
        trustedSessionIdB?: string,
        expiryAttempt = 0,
    ): Promise<RuntimeStateEntryValue<RttMeasurementInfo> | undefined> {
        const decoded = decodeMeasurementKey(entry.key);
        if (trustedSessionIdA !== undefined && trustedSessionIdB !== undefined) {
            const trusted = sortedPair(trustedSessionIdA, trustedSessionIdB);
            if (decoded[0] !== trusted[0] || decoded[1] !== trusted[1]) {
                throw rttCorruption(entry.key, 'RTC RTT key differs from requested pair');
            }
        }
        const value = parseValue(entry) as RttMeasurementInfo;
        try {
            validateMeasurement(value);
        } catch (error) {
            throw rttCorruption(
                entry.key,
                error instanceof Error ? error.message : 'RTC RTT value is invalid',
            );
        }
        const storedPair = sortedPair(value.sessionIdFrom, value.sessionIdTo);
        if (storedPair[0] !== decoded[0] || storedPair[1] !== decoded[1]) {
            throw rttCorruption(entry.key, 'RTC RTT value differs from physical pair');
        }
        return await this.toLiveVerifiedEntry(
            RTC_RTT_LATEST_NAMESPACE,
            entry,
            value,
            (replacement, nextAttempt) => this.toLiveMeasurementEntry(
                replacement,
                trustedSessionIdA,
                trustedSessionIdB,
                nextAttempt,
            ),
            expiryAttempt,
        );
    }

    private async toLiveEndpointAdmissionEntry(
        entry: RuntimeStateEntry,
        trustedEndpointId?: string,
        expiryAttempt = 0,
    ): Promise<RuntimeStateEntryValue<RtcRttEndpointAdmission> | undefined> {
        const endpointId = decodeEndpointKey(entry.key);
        if (trustedEndpointId !== undefined && endpointId !== trustedEndpointId) {
            throw rttCorruption(entry.key, 'RTC RTT endpoint differs from requested slot');
        }
        const value = parseValue(entry) as RtcRttEndpointAdmission;
        try {
            validateEndpointAdmission(value, endpointId, entry.expireAtTimestamp);
            validateRtcRttEndpointAdmissionPersistedVersion(
                value.version,
                entry.revision,
            );
        } catch (error) {
            throw rttCorruption(
                entry.key,
                error instanceof Error ? error.message : 'RTC RTT admission is invalid',
            );
        }
        return await this.toLiveVerifiedEntry(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            entry,
            value,
            (replacement, nextAttempt) => this.toLiveEndpointAdmissionEntry(
                replacement,
                trustedEndpointId,
                nextAttempt,
            ),
            expiryAttempt,
        );
    }

    private async toLiveVerifiedEntry<T>(
        namespace: string,
        entry: RuntimeStateEntry,
        value: T,
        decodeReplacement: (
            replacement: RuntimeStateEntry,
            nextAttempt: number,
        ) => Promise<RuntimeStateEntryValue<T> | undefined>,
        expiryAttempt = 0,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        if (entry.expireAtTimestamp > this.nowEpochMs()) return { entry, value };
        if (isRuntimeStateConditionalRepositoryLike(this.runtimeRepository)) {
            await waitForRuntimeStateWriteRetry(expiryAttempt as 0 | 1 | 2, {
                sleep: this.options.sleep,
            });
            const deleted = await this.runtimeRepository.deleteIfRevision(
                namespace,
                entry.key,
                entry.revision,
            );
            if (deleted.status === 'conflict') {
                const conflict = new RuntimeStateWriteConflictError();
                if (expiryAttempt >= 2) {
                    throw new RuntimeStateRetryExhaustedError(conflict);
                }
                const replacement = await this.runtimeRepository.findEntry(
                    namespace,
                    entry.key,
                );
                return replacement
                    ? await decodeReplacement(replacement, expiryAttempt + 1)
                    : undefined;
            }
        }
        return undefined;
    }

    private async toLiveReceiptEntry(
        entry: RuntimeStateEntry,
        trustedReceiptId?: string,
    ): Promise<RuntimeStateEntryValue<RtcRttMutationReceipt> | undefined> {
        const receipt = this.toReceiptEntry(entry, trustedReceiptId);
        return entry.expireAtTimestamp > this.nowEpochMs()
            ? receipt
            : undefined;
    }

    private toReceiptEntry(
        entry: RuntimeStateEntry,
        trustedReceiptId?: string,
    ): RuntimeStateEntryValue<RtcRttMutationReceipt> {
        if (trustedReceiptId !== undefined && entry.key !== trustedReceiptId) {
            throw rttCorruption(entry.key, 'RTC RTT receipt differs from trusted slot');
        }
        let value: RtcRttMutationReceipt;
        try {
            value = parseValue(entry) as RtcRttMutationReceipt;
            validateMutationReceipt(value);
            validateMutationReceiptPhysicalExpiry(
                value,
                entry.expireAtTimestamp,
            );
        } catch (error) {
            throw rttCorruption(
                entry.key,
                error instanceof Error ? error.message : 'Invalid RTT receipt',
            );
        }
        if (value.receiptId !== entry.key) {
            throw rttCorruption(entry.key, 'RTC RTT receipt differs from physical key');
        }
        return { entry, value };
    }

    private async toLiveRecomputeIntentEntry(
        entry: RuntimeStateEntry,
        trustedOutboxId?: string,
        expiryAttempt = 0,
    ): Promise<RuntimeStateEntryValue<RtcRttRecomputeIntent> | undefined> {
        const intent = this.toRecomputeIntentEntry(entry, trustedOutboxId);
        const receipt = await this.probeMutationReceiptEntry(intent.value.receiptId);
        if (!receipt) {
            throw rttCorruption(entry.key, 'RTC RTT recompute intent receipt is missing');
        }
        validateIntentAgainstReceipt(intent.value, receipt.value, entry.key);
        if (entry.expireAtTimestamp !== receipt.entry.expireAtTimestamp) {
            throw rttCorruption(
                entry.key,
                'RTC RTT recompute intent physical expiry differs from receipt',
            );
        }
        const observedAtEpochMs = this.nowEpochMs();
        if (entry.expireAtTimestamp > observedAtEpochMs) return intent;
        await this.cleanupExpiredReceiptFamily(
            receipt.value.receiptId,
            observedAtEpochMs,
            expiryAttempt,
        );
        return undefined;
    }

    private toRecomputeIntentEntry(
        entry: RuntimeStateEntry,
        trustedOutboxId?: string,
    ): RuntimeStateEntryValue<RtcRttRecomputeIntent> {
        if (trustedOutboxId !== undefined && entry.key !== trustedOutboxId) {
            throw rttCorruption(entry.key, 'RTC RTT recompute intent differs from trusted slot');
        }
        let value: RtcRttRecomputeIntent;
        try {
            value = parseValue(entry) as RtcRttRecomputeIntent;
            validateRecomputeIntent(value, entry.expireAtTimestamp);
        } catch (error) {
            throw rttCorruption(
                entry.key,
                error instanceof Error ? error.message : 'Invalid RTT recompute intent',
            );
        }
        if (value.outboxId !== entry.key) {
            throw rttCorruption(entry.key, 'RTC RTT recompute intent differs from physical key');
        }
        return { entry, value };
    }

    private async cleanupExpiredReceiptFamily(
        receiptId: string,
        observedAtEpochMs: number,
        expiryAttempt: number,
    ): Promise<boolean> {
        await waitForRuntimeStateWriteRetry(expiryAttempt as 0 | 1 | 2, {
            sleep: this.options.sleep,
        });
        try {
            const read = await this.readExpiredReceiptFamilyCleanup(receiptId);
            const computed = this.computeExpiredReceiptFamilyCleanup(read);
            this.validateExpiredReceiptFamilyCleanup(
                computed,
                observedAtEpochMs,
            );
            return await this.writeExpiredReceiptFamilyCleanup(computed);
        } catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
            if (expiryAttempt >= 2) {
                throw new RuntimeStateRetryExhaustedError(error);
            }
            return await this.cleanupExpiredReceiptFamily(
                receiptId,
                observedAtEpochMs,
                expiryAttempt + 1,
            );
        }
    }

    private async readExpiredReceiptFamilyCleanup(
        receiptId: string,
    ): Promise<RtcRttReceiptFamilyCleanupRead> {
        const runtime = requireOptimisticRuntime(this.runtimeRepository);
        const [receiptEntry, siblingEntries] = await Promise.all([
            runtime.findEntry(RTC_RTT_RECEIPTS_NAMESPACE, receiptId),
            runtime.findEntriesByPrefix(
                RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                `${receiptId}:commandHash=`,
            ),
        ]);
        return { receiptId, receiptEntry, siblingEntries };
    }

    private computeExpiredReceiptFamilyCleanup(
        read: RtcRttReceiptFamilyCleanupRead,
    ): RtcRttReceiptFamilyCleanupPlan {
        if (!read.receiptEntry && read.siblingEntries.length === 0) {
            return { outcome: 'absent' };
        }
        if (!read.receiptEntry) {
            throw rttCorruption(
                read.receiptId,
                'RTC RTT recompute intent receipt is missing',
            );
        }
        const receipt = this.toReceiptEntry(read.receiptEntry, read.receiptId);
        const siblings = read.siblingEntries.map((entry) =>
            this.toRecomputeIntentEntry(entry)
        ).sort((left, right) =>
            compareRtcTopologyIdentifiers(left.entry.key, right.entry.key)
        );
        return { outcome: 'delete', receipt, siblings };
    }

    private validateExpiredReceiptFamilyCleanup(
        plan: RtcRttReceiptFamilyCleanupPlan,
        observedAtEpochMs: number,
    ): void {
        if (plan.outcome === 'absent') return;
        if (plan.receipt.entry.expireAtTimestamp > observedAtEpochMs) {
            throw rttCorruption(
                plan.receipt.entry.key,
                'RTC RTT recompute receipt remains live during intent cleanup',
            );
        }
        const seenGroupRefs = new Set<string>();
        for (const sibling of plan.siblings) {
            validateIntentAgainstReceipt(
                sibling.value,
                plan.receipt.value,
                sibling.entry.key,
            );
            if (
                sibling.entry.expireAtTimestamp !==
                    plan.receipt.entry.expireAtTimestamp ||
                sibling.entry.expireAtTimestamp > observedAtEpochMs
            ) {
                throw rttCorruption(
                    sibling.entry.key,
                    'RTC RTT recompute sibling is not jointly expired with receipt',
                );
            }
            const groupIdentity = toCanonicalRtcTopologyGroupIdentity(
                sibling.value.groupSnapshot.group,
            );
            if (seenGroupRefs.has(groupIdentity)) {
                throw rttCorruption(
                    sibling.entry.key,
                    'RTC RTT receipt has duplicate recompute intent group',
                );
            }
            seenGroupRefs.add(groupIdentity);
        }
        const expectedGroupRefs = plan.receipt.value.affectedGroupRefs
            .map(toCanonicalRtcTopologyGroupIdentity)
            .sort(compareRtcTopologyIdentifiers);
        const actualGroupRefs = [...seenGroupRefs]
            .sort(compareRtcTopologyIdentifiers);
        if (!rtcTopologySemanticEqual(actualGroupRefs, expectedGroupRefs)) {
            throw rttCorruption(
                plan.receipt.entry.key,
                'RTC RTT receipt recompute intent set is incomplete',
            );
        }
    }

    private async writeExpiredReceiptFamilyCleanup(
        plan: RtcRttReceiptFamilyCleanupPlan,
    ): Promise<boolean> {
        if (plan.outcome === 'absent') return false;
        const runtime = requireOptimisticRuntime(this.runtimeRepository);
        return await runtime.begin(async (transaction) => {
            const guardedReceipt = await transaction.upsertIfRevision(
                RTC_RTT_RECEIPTS_NAMESPACE,
                plan.receipt.entry.key,
                plan.receipt.entry.value,
                plan.receipt.entry.expireAtTimestamp,
                plan.receipt.entry.revision,
            );
            if (guardedReceipt.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            for (const sibling of plan.siblings) {
                const deleted = await transaction.deleteIfRevision(
                    RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                    sibling.entry.key,
                    sibling.entry.revision,
                );
                if (deleted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
            const deletedReceipt = await transaction.deleteIfRevision(
                RTC_RTT_RECEIPTS_NAMESPACE,
                plan.receipt.entry.key,
                guardedReceipt.revision,
            );
            if (deletedReceipt.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            return true;
        });
    }
}

export function initRtcRttReceiptFamilyCleanup(
    repository: RtcRttRepository,
    options: RtcRttReceiptFamilyCleanupOptions = {},
): RtcRttReceiptFamilyCleanupHandle {
    const intervalMs = options.intervalMs ??
        DEFAULT_RTC_RTT_RECEIPT_FAMILY_CLEANUP_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new RangeError('RTC RTT receipt family cleanup interval is invalid');
    }
    const schedule = options.schedule ?? ((callback: () => void, delayMs: number) =>
        setTimeout(callback, delayMs));
    const cancel = options.cancel ?? ((handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>));
    let stopped = false;
    let scheduledHandle: unknown;

    const run = async (surfaceFailure: boolean): Promise<number> => {
        try {
            return await repository.cleanupExpiredReceiptFamilies();
        } catch (error) {
            if (surfaceFailure) throw error;
            options.onError?.(error);
            return 0;
        } finally {
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
        },
    };
}

export async function migrateLegacyRtcRttRecomputeIntentDeliveryState(
    repository: RtcRttRepository,
    options: Readonly<{
        oldWritersStopped: true;
        sleep?: (delayMs: number) => Promise<void>;
    }>,
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
        let migrated = false;
        for (let attempt = 0; attempt < 3 && !migrated; attempt += 1) {
            await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
                sleep: options.sleep,
            });
            try {
                await runtime.begin(async (transaction) => {
                    const current = await transaction.findEntry(
                        RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE,
                        source.key,
                    );
                    if (!current) return;
                    const raw = parseValue(current);
                    if (isRecord(raw) && Object.hasOwn(raw, 'delivery')) {
                        try {
                            validateRecomputeIntent(raw, current.expireAtTimestamp);
                        } catch (error) {
                            throw rttCorruption(
                                current.key,
                                error instanceof Error
                                    ? error.message
                                    : 'Invalid RTC RTT recompute intent',
                            );
                        }
                        return;
                    }
                    const legacy = readLegacyRecomputeIntentForMigration(
                        current,
                    );
                    const receiptEntry = await transaction.findEntry(
                        RTC_RTT_RECEIPTS_NAMESPACE,
                        legacy.receiptId,
                    );
                    if (!receiptEntry) {
                        throw rttCorruption(
                            current.key,
                            'Legacy RTC RTT recompute intent receipt is missing',
                        );
                    }
                    let receipt: RtcRttMutationReceipt;
                    try {
                        receipt = parseValue(receiptEntry) as RtcRttMutationReceipt;
                        validateMutationReceipt(receipt);
                        validateMutationReceiptPhysicalExpiry(
                            receipt,
                            receiptEntry.expireAtTimestamp,
                        );
                    } catch (error) {
                        throw rttCorruption(
                            receiptEntry.key,
                            error instanceof Error
                                ? error.message
                                : 'Invalid RTC RTT receipt',
                        );
                    }
                    if (
                        receipt.receiptId !== receiptEntry.key ||
                        receiptEntry.expireAtTimestamp !== current.expireAtTimestamp
                    ) {
                        throw rttCorruption(
                            current.key,
                            'Legacy RTC RTT recompute intent family differs from receipt',
                        );
                    }
                    const upgraded = {
                        ...legacy,
                        delivery: { state: 'pending' },
                    } as const satisfies RtcRttRecomputeIntent;
                    validateRecomputeIntent(upgraded, current.expireAtTimestamp);
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
                migrated = true;
            } catch (error) {
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                if (attempt >= 2) {
                    throw new RuntimeStateRetryExhaustedError(error);
                }
            }
        }
    }
}

export async function migrateLegacyRtcRttMeasurementKeys(
    repository: RtcRttRepository,
    options: Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error('RTC RTT migration requires old writers stopped');
    }
    const runtime = requireOptimisticRuntime(repository.runtimeRepository);
    const entries = await runtime.findAllEntries(RTC_RTT_LATEST_NAMESPACE);
    for (const source of entries) {
        const value = parseValue(source) as RttMeasurementInfo;
        validateMeasurement(value);
        const destinationKey = repository.measurementKey(
            value.sessionIdFrom,
            value.sessionIdTo,
        );
        if (source.key === destinationKey) continue;
        const [from, to] = sortedPair(value.sessionIdFrom, value.sessionIdTo);
        const legacyKey = `pair=${encodeURIComponent(`${from}::${to}`)}`;
        if (source.key !== legacyKey) {
            throw rttCorruption(source.key, 'Legacy RTC RTT key differs from value');
        }
        await runtime.begin(async (transaction) => {
            const migrated = new RtcRttRepository(transaction, { now: () => 0 });
            const destination = await migrated.findMeasurement(
                value.sessionIdFrom,
                value.sessionIdTo,
            );
            if (destination) {
                if (!rtcTopologySemanticEqual(destination, value)) {
                    throw rttCorruption(
                        destinationKey,
                        'Canonical RTC RTT value differs from legacy source',
                    );
                }
            } else {
                const inserted = await transaction.insertIfAbsent(
                    RTC_RTT_LATEST_NAMESPACE,
                    destinationKey,
                    JSON.stringify(value),
                    source.expireAtTimestamp,
                );
                if (inserted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
            const deleted = await transaction.deleteIfRevision(
                RTC_RTT_LATEST_NAMESPACE,
                source.key,
                source.revision,
            );
            if (deleted.status === 'conflict') throw new RuntimeStateWriteConflictError();
        });
    }
}

export function validateMeasurement(value: unknown): asserts value is RttMeasurementInfo {
    validatePersistedRtcRttMeasurement(value);
}

export function validateEndpointAdmission(
    value: unknown,
    expectedEndpointId: string,
    physicalExpiry: number,
): asserts value is RtcRttEndpointAdmission {
    validatePersistedRtcRttEndpointAdmission(
        value,
        expectedEndpointId,
        physicalExpiry,
    );
}

function validateMutationReceipt(
    value: unknown,
): asserts value is RtcRttMutationReceipt {
    validatePersistedRtcRttMutationReceipt(value);
}

function validateMutationReceiptPhysicalExpiry(
    receipt: RtcRttMutationReceipt,
    physicalExpiry: number,
): void {
    validatePersistedRtcRttMutationReceipt(receipt, physicalExpiry);
}

type LegacyRtcRttRecomputeIntent = Pick<
    RtcRttRecomputeIntent,
    | 'outboxId'
    | 'receiptId'
    | 'groupSnapshot'
    | 'rtt'
    | 'createdAtEpochMs'
    | 'commandHash'
>;

function readLegacyRecomputeIntentForMigration(
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
        validateRecomputeIntentBase(value);
        return value as LegacyRtcRttRecomputeIntent;
    } catch (error) {
        throw rttCorruption(
            entry.key,
            error instanceof Error
                ? error.message
                : 'Invalid legacy RTC RTT recompute intent',
        );
    }
}

function validateRecomputeIntent(
    value: unknown,
    physicalExpiry?: number,
): asserts value is RtcRttRecomputeIntent {
    validatePersistedRtcRttRecomputeIntent(value, physicalExpiry);
}

function validateRecomputeIntentBase(value: Record<string, unknown>): void {
    if (
        typeof value.outboxId !== 'string' || value.outboxId.length === 0 ||
        typeof value.receiptId !== 'string' || value.receiptId.length === 0 ||
        typeof value.createdAtEpochMs !== 'number' ||
        !Number.isSafeInteger(value.createdAtEpochMs) || value.createdAtEpochMs < 0
    ) {
        throw new TypeError('RTC RTT recompute intent fields are invalid');
    }
    validateCommandHash(value.commandHash);
    validatePersistedGroupSnapshot(value.groupSnapshot);
    validateMeasurement(value.rtt);
    const groupRef = value.groupSnapshot.group;
    const expectedReceiptId = toRtcRttMutationReceiptId(value.rtt);
    if (
        value.receiptId !== expectedReceiptId ||
        value.outboxId !== toRtcRttRecomputeOutboxId(
            expectedReceiptId,
            groupRef,
            value.commandHash,
        )
    ) {
        throw new TypeError('RTC RTT recompute intent identity is invalid');
    }
}

function validateCommandHash(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new TypeError('RTC RTT command hash is invalid');
    }
}

function validateIntentAgainstReceipt(
    intent: RtcRttRecomputeIntent,
    receipt: RtcRttMutationReceipt,
    storageKey: string,
): void {
    const groupKey = groupStateGroupStorageKey(intent.groupSnapshot.group);
    const receiptIncludesGroup = receipt.affectedGroupRefs.some((ref) =>
        groupStateGroupStorageKey(ref) === groupKey
    );
    const activeSessionIds = new Set(
        intent.groupSnapshot.activeSessions
            .filter(({ connectedAtEpochMs, expiresAtEpochMs }) =>
                connectedAtEpochMs <= intent.createdAtEpochMs &&
                expiresAtEpochMs > intent.createdAtEpochMs
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
        (groupExpiry !== undefined && groupExpiry <= intent.createdAtEpochMs) ||
        !activeSessionIds.has(receipt.sessionIdFrom) ||
        !activeSessionIds.has(receipt.sessionIdTo)
    ) {
        throw rttCorruption(
            storageKey,
            'RTC RTT recompute intent differs from immutable receipt authority',
        );
    }
}

function decodeMeasurementKey(storageKey: string): readonly [string, string] {
    const parts = storageKey.split(':');
    if (parts.length !== 2 || !parts[0]!.startsWith('from=') ||
        !parts[1]!.startsWith('to=')) {
        throw rttCorruption(storageKey, 'RTC RTT measurement key has invalid shape');
    }
    let from: string;
    let to: string;
    try {
        from = decodeURIComponent(parts[0]!.slice('from='.length));
        to = decodeURIComponent(parts[1]!.slice('to='.length));
    } catch {
        throw rttCorruption(storageKey, 'RTC RTT measurement key encoding is invalid');
    }
    if (
        from.length === 0 || to.length === 0 ||
        compareRtcTopologyIdentifiers(from, to) >= 0
    ) {
        throw rttCorruption(storageKey, 'RTC RTT measurement key is not canonical');
    }
    const canonical = `from=${encodeURIComponent(from)}:to=${encodeURIComponent(to)}`;
    if (canonical !== storageKey) {
        throw rttCorruption(storageKey, 'RTC RTT measurement key is not canonical');
    }
    return [from, to];
}

function decodeEndpointKey(storageKey: string): string {
    if (!storageKey.startsWith('endpoint=')) {
        throw rttCorruption(storageKey, 'RTC RTT endpoint key has invalid shape');
    }
    let endpointId: string;
    try {
        endpointId = decodeURIComponent(storageKey.slice('endpoint='.length));
    } catch {
        throw rttCorruption(storageKey, 'RTC RTT endpoint key encoding is invalid');
    }
    if (
        endpointId.length === 0 ||
        `endpoint=${encodeURIComponent(endpointId)}` !== storageKey
    ) {
        throw rttCorruption(storageKey, 'RTC RTT endpoint key is not canonical');
    }
    return endpointId;
}

function sortedPair(left: string, right: string): readonly [string, string] {
    return compareRtcTopologyIdentifiers(left, right) <= 0
        ? [left, right]
        : [right, left];
}

function sameMeasurement(
    left: RttMeasurementInfo,
    right: RttMeasurementInfo,
): boolean {
    return left.sessionIdFrom === right.sessionIdFrom &&
        left.sessionIdTo === right.sessionIdTo &&
        left.rttMs === right.rttMs &&
        left.createdAtEpochMs === right.createdAtEpochMs &&
        left.version === right.version;
}

function parseValue(entry: RuntimeStateEntry): unknown {
    try {
        return JSON.parse(entry.value);
    } catch (error) {
        throw rttCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC RTT JSON is invalid',
        );
    }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (!rtcTopologySemanticEqual(Object.keys(value).sort(), [...keys].sort())) {
        throw new TypeError('RTC RTT persisted value has invalid keys');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rttCorruption(
    storageKey: string,
    message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}

function toCleanupFailureError(
    error: unknown,
): RtcRttReceiptFamilyCleanupFailure['error'] {
    if (error instanceof RtcTopologyRepositoryInvariantCorruptionError) {
        return {
            name: error.name,
            message: 'RTC RTT receipt family authority is corrupt',
            code: error.code,
        };
    }
    if (
        error instanceof RuntimeStateRetryExhaustedError ||
        error instanceof RuntimeStateWriteConflictError
    ) {
        return {
            name: error.name,
            message: 'RTC RTT receipt family cleanup exhausted optimistic retries',
        };
    }
    return {
        name: error instanceof Error ? error.name : 'Error',
        message: 'RTC RTT receipt family cleanup failed',
    };
}

function compact<T>(values: readonly (T | undefined)[]): readonly T[] {
    return values.filter((value): value is T => value !== undefined);
}

function requireConditionalRuntime(
    runtime: RuntimeStateRepositoryLike,
) {
    if (!isRuntimeStateConditionalRepositoryLike(runtime)) {
        throw new Error('RTC RTT repository requires conditional writes');
    }
    return runtime;
}

function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC RTT repository requires optimistic transactions');
    }
    return runtime;
}
