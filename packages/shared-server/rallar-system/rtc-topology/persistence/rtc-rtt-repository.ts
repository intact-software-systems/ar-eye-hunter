import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
    RuntimeStateEntryRead,
    RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { RuntimeStateWriteConflictError }
    from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RtcRttMutationLifecycleFacts } from '../mutation/rtc-rtt-mutation-contracts.ts';
import type {
    RtcRttEndpointAdmission,
    RtcRttMutationReceipt,
} from './rtc-rtt-persistence-contracts.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../rtc-topology-errors.ts';
import { cleanupExpiredRtcRttReceipts } from './rtc-rtt-receipt-cleanup.ts';
import {
    readLiveRtcRttEndpointAdmissionEntry,
    readLiveRtcRttMeasurementEntry,
    readLiveRtcRttReceiptEntry,
    readRtcRttReceiptEntry,
} from './read-rtc-rtt-persisted-entry.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE,
} from './rtc-rtt-runtime-namespaces.ts';
import {
    toRtcRttEndpointAdmissionStorageKey,
    toRtcRttMeasurementStorageKey,
} from './rtc-rtt-storage-keys.ts';
import {
    validateRtcRttEndpointAdmissionCandidateVersion,
    validateRtcRttEndpointAdmission,
    validateRtcRttMeasurement,
    validateRtcRttMutationReceipt,
} from './rtc-rtt-persistence-validation.ts';

const DEFAULT_RTC_RTT_TTL_MS = 60_000;

export type RtcRttRepositoryOptions = Readonly<{
    ttlMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>;

export type RtcRttConditionalWriteResult =
    | Readonly<{ status: 'accepted'; storageRevision: number }>
    | Readonly<{ status: 'conflict' }>;

export class RtcRttRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;
    private readonly options: RtcRttRepositoryOptions;

    constructor(
        runtimeRepository: RuntimeStateRepositoryLike,
        options: RtcRttRepositoryOptions = {},
    ) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
        this.options = options;
    }

    async findMeasurementEntry(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<RuntimeStateEntryValue<RttMeasurementInfo> | undefined> {
        return (await this.readMeasurementEntry(sessionIdA, sessionIdB)).value;
    }

    async readMeasurementEntry(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<RuntimeStateEntryRead<RttMeasurementInfo>> {
        const key = this.measurementKey(sessionIdA, sessionIdB);
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_LATEST_NAMESPACE,
            key,
        );
        if (!entry) return { value: undefined, expiredEntry: undefined };
        const value = readLiveRtcRttMeasurementEntry({
            entry,
            nowEpochMs: this.nowEpochMs(),
            trustedSessionIdA: sessionIdA,
            trustedSessionIdB: sessionIdB,
        });
        return value
            ? { value, expiredEntry: undefined }
            : { value: undefined, expiredEntry: entry };
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
        return compact(
            entries.map((entry) =>
                readLiveRtcRttMeasurementEntry({
                    entry,
                    nowEpochMs: this.nowEpochMs(),
                }),
            ),
        );
    }

    async listMeasurementEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RttMeasurementInfo>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_LATEST_NAMESPACE,
            '',
            options,
        );
        return compact(
            entries.map((entry) =>
                readLiveRtcRttMeasurementEntry({
                    entry,
                    nowEpochMs: this.nowEpochMs(),
                }),
            ),
        );
    }

    async listMeasurements(): Promise<readonly RttMeasurementInfo[]> {
        return (await this.listMeasurementEntries()).map(({ value }) => value);
    }

    async listMeasurementsForSessionIds(
        sessionIds: readonly string[],
    ): Promise<readonly RttMeasurementInfo[]> {
        const sessionSet = new Set(sessionIds);
        return (await this.listMeasurements()).filter(
            (measurement) =>
                sessionSet.has(measurement.sessionIdFrom) &&
                sessionSet.has(measurement.sessionIdTo),
        );
    }

    async findEndpointAdmissionEntry(
        endpointId: string,
    ): Promise<RuntimeStateEntryValue<RtcRttEndpointAdmission> | undefined> {
        return (await this.readEndpointAdmissionEntry(endpointId)).value;
    }

    async readEndpointAdmissionEntry(
        endpointId: string,
    ): Promise<RuntimeStateEntryRead<RtcRttEndpointAdmission>> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            this.endpointAdmissionKey(endpointId),
        );
        if (!entry) return { value: undefined, expiredEntry: undefined };
        const value = readLiveRtcRttEndpointAdmissionEntry(
            entry,
            this.nowEpochMs(),
            endpointId,
        );
        return value
            ? { value, expiredEntry: undefined }
            : { value: undefined, expiredEntry: entry };
    }

    async listEndpointAdmissionEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
        );
        return compact(
            entries.map((entry) =>
                readLiveRtcRttEndpointAdmissionEntry(entry, this.nowEpochMs()),
            ),
        );
    }

    async listEndpointAdmissionEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
            '',
            options,
        );
        return compact(
            entries.map((entry) =>
                readLiveRtcRttEndpointAdmissionEntry(entry, this.nowEpochMs()),
            ),
        );
    }

    async commitMeasurement(
        measurement: RttMeasurementInfo,
        expectedRevision: number | null,
        purgeAfterEpochMs: number,
    ): Promise<RtcRttConditionalWriteResult> {
        validateRtcRttMeasurement(measurement);
        const result =
            expectedRevision === null
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
        validateRtcRttEndpointAdmission(
            admission,
            admission.endpointId,
            expireAtTimestamp,
        );
        validateRtcRttEndpointAdmissionCandidateVersion(
            admission.version,
            expectedRevision,
        );
        const result =
            expectedRevision === null
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
        validateRtcRttMutationReceipt(receipt, expireAtTimestamp);
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
            return readRtcRttReceiptEntry(entry, receiptId);
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
        return compact(
            entries.map((entry) =>
                readLiveRtcRttReceiptEntry(entry, this.nowEpochMs()),
            ),
        );
    }

    async listMutationReceiptEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcRttMutationReceipt>[]> {
        const entries = await this.listEntriesPage(
            RTC_RTT_RECEIPTS_NAMESPACE,
            '',
            options,
        );
        return compact(
            entries.map((entry) =>
                readLiveRtcRttReceiptEntry(entry, this.nowEpochMs()),
            ),
        );
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
        if (current && current.value.version > measurement.version)
            return false;
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
        return toRtcRttMeasurementStorageKey(sessionIdA, sessionIdB);
    }

    endpointAdmissionKey(endpointId: string): string {
        return toRtcRttEndpointAdmissionStorageKey(endpointId);
    }

    defaultPurgeAfterEpochMs(): number {
        return (
            this.nowEpochMs() + (this.options.ttlMs ?? DEFAULT_RTC_RTT_TTL_MS)
        );
    }

    readMutationFacts(): RtcRttMutationLifecycleFacts {
        const requestedAtEpochMs = this.nowEpochMs();
        return {
            requestedAtEpochMs,
            purgeAfterEpochMs:
                requestedAtEpochMs +
                (this.options.ttlMs ?? DEFAULT_RTC_RTT_TTL_MS),
        };
    }

    nowEpochMs(): number {
        return this.options.now?.() ?? Date.now();
    }

    async cleanupExpiredReceiptFamilies(): Promise<number> {
        return await cleanupExpiredRtcRttReceipts(this);
    }
}

function sameMeasurement(
    left: RttMeasurementInfo,
    right: RttMeasurementInfo,
): boolean {
    return (
        left.sessionIdFrom === right.sessionIdFrom &&
        left.sessionIdTo === right.sessionIdTo &&
        left.rttMs === right.rttMs &&
        left.createdAtEpochMs === right.createdAtEpochMs &&
        left.version === right.version
    );
}

function rttCorruption(
    storageKey: string,
    message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(
        storageKey,
        message,
    );
}

function compact<T>(values: readonly (T | undefined)[]): readonly T[] {
    return values.filter((value): value is T => value !== undefined);
}
