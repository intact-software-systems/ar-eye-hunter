import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';

import type { RtcRttEndpointAdmission, RtcRttMutationReceipt } from '../persistence/rtc-rtt-persistence-contracts.ts';
import type { RtcRttAcceptanceReason } from '../policy/rtc-rtt-measurement-policy.ts';

export type RtcRttStableRequest = Readonly<{
    rtt: RttMeasurementInfo;
    alSenderId: string;
}>;

export type RtcRttMutationCommand =
    & RtcRttStableRequest
    & (
        | Readonly<{
            candidateGroups: null;
            overlaySnapshotsByGroupKey: null;
            degreeLimit: null;
        }>
        | Readonly<{
            candidateGroups: readonly GroupSnapshot[];
            overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
            degreeLimit: number;
        }>
    );

export type RtcRttMutationRead =
    | Readonly<{
        receipt: RuntimeStateEntryValue<RtcRttMutationReceipt>;
    }>
    | Readonly<{
        receipt: null;
        measurement: RuntimeStateEntryValue<RttMeasurementInfo> | null;
        expiredMeasurementEntry: RuntimeStateEntry | null;
        endpointAdmissions: readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[];
        expiredEndpointAdmissionEntries: readonly RuntimeStateEntry[];
        measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[];
    }>;

export type RtcRttMutationFacts =
    & (
        | Readonly<{
            purgeAfterEpochMs: null;
            requestedAtEpochMs: null;
        }>
        | RtcRttMutationLifecycleFacts
    )
    & Readonly<{
        commandHash: string;
        attemptCount: number;
    }>;

export type RtcRttMutationLifecycleFacts = Readonly<{
    purgeAfterEpochMs: number;
    requestedAtEpochMs: number;
}>;

export type RtcRttEndpointGuard = Readonly<{
    endpointId: string;
    expectedRevision: number | null;
    expireAtTimestamp: number;
    value: RtcRttEndpointAdmission;
}>;

export type RtcRttRuntimeWrite =
    | Readonly<{
        operation: 'insert';
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
        expectedResultRevision: 0;
    }>
    | Readonly<{
        operation: 'update';
        namespace: string;
        key: string;
        value: string;
        expireAtIsoTimestamp: string;
        expectedRevision: number;
        expectedResultRevision: number;
    }>;

export type RtcRttMutationComputed =
    | Readonly<{
        outcome: 'replay';
        reason: 'accepted';
        affectedGroups: readonly GroupSnapshot[];
        receipt: RtcRttMutationReceipt;
    }>
    | Readonly<{
        outcome: 'rejected';
        reason: RtcRttAcceptanceReason | 'stale';
        affectedGroups: readonly GroupSnapshot[];
    }>
    | Readonly<{
        outcome: 'write';
        reason: 'accepted';
        affectedGroups: readonly GroupSnapshot[];
        endpointGuards: readonly RtcRttEndpointGuard[];
        measurementGuard: Readonly<{
            expectedRevision: number | null;
            value: RttMeasurementInfo;
            purgeAfterEpochMs: number;
        }>;
        receipt: RtcRttMutationReceipt;
        senderId: string;
        runtimeWrites: readonly RtcRttRuntimeWrite[];
        outboxWrites: readonly AppOutboxInsert[];
    }>;
