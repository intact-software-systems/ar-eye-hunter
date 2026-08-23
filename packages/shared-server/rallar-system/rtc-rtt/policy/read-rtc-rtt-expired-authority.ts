import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validateRuntimeStateExpiredAuthority } from '../../../runtime-state/runtime-state-expired-entry.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity
} from '../../topology/persistence/rtc-topology-identifiers.ts';
import type { RtcRttEndpointAdmission } from '../persistence/rtc-rtt-persistence-contracts.ts';
import {
    toRtcRttEndpointAdmissionStorageKey,
    toRtcRttMeasurementStorageKey
} from '../persistence/rtc-rtt-storage-keys.ts';

export interface RtcRttExpiredAuthority {
    readonly admissionByEndpoint: ReadonlyMap<string, RuntimeStateEntryValue<RtcRttEndpointAdmission>>;
    readonly expiredAdmissionByEndpoint: ReadonlyMap<string, RuntimeStateEntry>;
}

export function readRtcRttExpiredAuthority(
    input: Readonly<{
        sessionIdFrom: string;
        sessionIdTo: string;
        measurement: RuntimeStateEntryValue<RttMeasurementInfo> | null;
        expiredMeasurementEntry: RuntimeStateEntry | null;
        endpointAdmissions: readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[];
        expiredEndpointAdmissionEntries: readonly RuntimeStateEntry[];
    }>
): RtcRttExpiredAuthority {
    validateRuntimeStateExpiredAuthority({
        live: input.measurement,
        expiredEntry: input.expiredMeasurementEntry,
        expectedKey: toRtcRttMeasurementStorageKey(
            input.sessionIdFrom,
            input.sessionIdTo
        ),
        label: 'RTC RTT measurement read'
    });
    const admissionByEndpoint = new Map(
        input.endpointAdmissions.map((stored) => [stored.value.endpointId, stored])
    );
    const expiredByKey = new Map(
        input.expiredEndpointAdmissionEntries.map((entry) => [entry.key, entry])
    );
    if (expiredByKey.size !== input.expiredEndpointAdmissionEntries.length) {
        throw new TypeError('RTC RTT expired endpoint admission keys are duplicated');
    }
    const expiredAdmissionByEndpoint = new Map<string, RuntimeStateEntry>();
    for (const endpointId of [input.sessionIdFrom, input.sessionIdTo]) {
        const key = toRtcRttEndpointAdmissionStorageKey(endpointId);
        const expired = expiredByKey.get(key) ?? null;
        validateRuntimeStateExpiredAuthority({
            live: admissionByEndpoint.get(endpointId),
            expiredEntry: expired,
            expectedKey: key,
            label: 'RTC RTT endpoint admission read'
        });
        if (expired) {
            expiredAdmissionByEndpoint.set(endpointId, expired);
        }
        expiredByKey.delete(key);
    }
    if (expiredByKey.size > 0) {
        throw new TypeError('RTC RTT expired endpoint admission is outside the command');
    }
    return { admissionByEndpoint, expiredAdmissionByEndpoint };
}

export function canonicalRtcRttGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}

export function canonicalRtcRttAffectedGroups(
    groups: readonly GroupSnapshot[]
): readonly GroupSnapshot[] {
    const byKey = new Map<string, GroupSnapshot>();
    for (const group of groups) {
        const key = toCanonicalRtcTopologyGroupIdentity(group.group);
        if (!byKey.has(key)) {
            byKey.set(key, group);
        }
    }
    return [...byKey]
        .sort(([left], [right]) => compareRtcTopologyIdentifiers(left, right))
        .map(([, group]) => group);
}
