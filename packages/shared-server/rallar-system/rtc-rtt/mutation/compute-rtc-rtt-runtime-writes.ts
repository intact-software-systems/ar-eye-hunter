import { encodeRuntimeStateJsonValue } from '../../../runtime-state/runtime-state-json-store.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '../persistence/rtc-rtt-runtime-namespaces.ts';
import {
    toRtcRttEndpointAdmissionStorageKey,
    toRtcRttMeasurementStorageKey
} from '../persistence/rtc-rtt-storage-keys.ts';
import type { RtcRttMutationComputed, RtcRttRuntimeWrite } from './rtc-rtt-mutation-contracts.ts';

type RtcRttWriteSource = Omit<Extract<RtcRttMutationComputed, { outcome: 'write'; }>, 'runtimeWrites' | 'outboxWrites'>;

export function computeRtcRttRuntimeWrites(
    computed: RtcRttWriteSource,
    receiptExpireAtEpochMs: number
): readonly RtcRttRuntimeWrite[] {
    return [
        ...computed.endpointGuards.map((guard) =>
            runtimeWrite({
                namespace: RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
                key: toRtcRttEndpointAdmissionStorageKey(guard.endpointId),
                value: guard.value,
                expireAtEpochMs: guard.expireAtTimestamp,
                expectedRevision: guard.expectedRevision
            })
        ),
        runtimeWrite({
            namespace: RTC_RTT_LATEST_NAMESPACE,
            key: toRtcRttMeasurementStorageKey(
                computed.measurementGuard.value.sessionIdFrom,
                computed.measurementGuard.value.sessionIdTo
            ),
            value: computed.measurementGuard.value,
            expireAtEpochMs: computed.measurementGuard.purgeAfterEpochMs,
            expectedRevision: computed.measurementGuard.expectedRevision
        }),
        runtimeWrite({
            namespace: RTC_RTT_RECEIPTS_NAMESPACE,
            key: computed.receipt.receiptId,
            value: computed.receipt,
            expireAtEpochMs: receiptExpireAtEpochMs,
            expectedRevision: null
        })
    ];
}

function runtimeWrite(
    input: Readonly<{
        namespace: string;
        key: string;
        value: object;
        expireAtEpochMs: number;
        expectedRevision: number | null;
    }>
): RtcRttRuntimeWrite {
    const value = encodeRuntimeStateJsonValue(input.value);
    const expireAtIsoTimestamp = new Date(input.expireAtEpochMs).toISOString();
    return input.expectedRevision === null
        ? {
            operation: 'insert',
            namespace: input.namespace,
            key: input.key,
            value,
            expireAtIsoTimestamp,
            expectedResultRevision: 0
        }
        : {
            operation: 'update',
            namespace: input.namespace,
            key: input.key,
            value,
            expireAtIsoTimestamp,
            expectedRevision: input.expectedRevision,
            expectedResultRevision: input.expectedRevision + 1
        };
}
