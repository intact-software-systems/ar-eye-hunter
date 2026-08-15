import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { validateRuntimeStateExpiredAuthority }
    from '../../../runtime-state/RuntimeStateExpiredEntry.ts';
import {
  compareRtcTopologyIdentifiers,
  toCanonicalRtcTopologyGroupIdentity,
} from '../../rtc-topology-identifiers.ts';
import {
  toRtcRttEndpointAdmissionStorageKey,
  toRtcRttMeasurementStorageKey,
} from '../persistence/rtc-rtt-storage-keys.ts';
// prettier-ignore
import type { RtcRttEndpointAdmission }
    from '../persistence/rtc-rtt-persistence-contracts.ts';

export interface RtcRttExpiredAuthority {
  readonly admissionByEndpoint: ReadonlyMap<
    string,
    RuntimeStateEntryValue<RtcRttEndpointAdmission>
  >;
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
  }>,
): RtcRttExpiredAuthority {
  validateRuntimeStateExpiredAuthority(
    input.measurement,
    input.expiredMeasurementEntry,
    toRtcRttMeasurementStorageKey(input.sessionIdFrom, input.sessionIdTo),
    'RTC RTT measurement read',
  );
  const admissionByEndpoint = new Map(
    input.endpointAdmissions.map((stored) => [stored.value.endpointId, stored]),
  );
  const expiredByKey = new Map(
    input.expiredEndpointAdmissionEntries.map((entry) => [entry.key, entry]),
  );
  if (expiredByKey.size !== input.expiredEndpointAdmissionEntries.length) {
    throw new TypeError('RTC RTT expired endpoint admission keys are duplicated');
  }
  const expiredAdmissionByEndpoint = new Map<string, RuntimeStateEntry>();
  for (const endpointId of [input.sessionIdFrom, input.sessionIdTo]) {
    const key = toRtcRttEndpointAdmissionStorageKey(endpointId);
    const expired = expiredByKey.get(key) ?? null;
    validateRuntimeStateExpiredAuthority(
      admissionByEndpoint.get(endpointId),
      expired,
      key,
      'RTC RTT endpoint admission read',
    );
    if (expired) expiredAdmissionByEndpoint.set(endpointId, expired);
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
    groupId: ref.groupId,
  };
}

export function canonicalRtcRttAffectedGroups(
  groups: readonly GroupSnapshot[],
): readonly GroupSnapshot[] {
  const byKey = new Map<string, GroupSnapshot>();
  for (const group of groups) {
    const key = toCanonicalRtcTopologyGroupIdentity(group.group);
    if (!byKey.has(key)) byKey.set(key, group);
  }
  return [...byKey]
    .sort(([left], [right]) => compareRtcTopologyIdentifiers(left, right))
    .map(([, group]) => group);
}
