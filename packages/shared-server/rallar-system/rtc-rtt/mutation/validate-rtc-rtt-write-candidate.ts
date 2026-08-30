import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as snapshotValidation from '../../group-state/snapshot/validate-persisted-group-snapshot.ts';
import { encodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity
} from '../../topology/persistence/rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../topology/persistence/rtc-topology-semantic-equal.ts';
import type { RtcRttEndpointAdmission, RtcRttMutationReceipt } from '../persistence/rtc-rtt-persistence-contracts.ts';
import {
    validateRtcRttEndpointAdmission,
    validateRtcRttEndpointAdmissionCandidateVersion,
    validateRtcRttMeasurement,
    validateRtcRttMutationReceipt
} from '../persistence/rtc-rtt-persistence-validation.ts';
import type { RtcRttMutationComputed } from './rtc-rtt-mutation-contracts.ts';
import { toRtcRttTopologyOutboxId } from './rtc-rtt-mutation-identifiers.ts';

export function validateRtcRttWriteCandidate(
    value: Extract<RtcRttMutationComputed, { outcome: 'write'; }>,
    mutationExpireAtTimestamp: number
): void {
    const candidate = record(
        encodeJsonWireValue(value, 'RTC RTT write candidate'),
        'RTC RTT write candidate'
    );
    exactKeys(candidate, [
        'outcome',
        'reason',
        'affectedGroups',
        'endpointGuards',
        'measurementGuard',
        'receipt',
        'senderId'
    ]);
    if (candidate.outcome !== 'write' || candidate.reason !== 'accepted') {
        throw new TypeError('RTC RTT write candidate discriminant is invalid');
    }
    const receipt = candidate.receipt;
    validateRtcRttMutationReceipt(receipt, mutationExpireAtTimestamp);
    const canonicalReceipt = receipt as RtcRttMutationReceipt;
    nonEmptyString(candidate.senderId, 'sender id');
    const expectedGroups = canonicalReceipt.affectedGroupRefs.map(
        toCanonicalRtcTopologyGroupIdentity
    );
    validateAffectedGroups(candidate.affectedGroups, expectedGroups, canonicalReceipt);
    const measurement = validateMeasurementGuard(candidate.measurementGuard, canonicalReceipt);
    validateEndpointGuards(candidate.endpointGuards, canonicalReceipt, measurement.purgeAfterEpochMs);
}

function validateAffectedGroups(
    value: JsonWireValue,
    expectedGroups: readonly string[],
    receipt: RtcRttMutationReceipt
): void {
    if (!Array.isArray(value) || value.length !== expectedGroups.length) {
        throw new TypeError('RTC RTT affected group set is incomplete');
    }
    const observed: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const rawGroup = value[index];
        snapshotValidation.validatePersistedGroupSnapshot(rawGroup);
        const group = rawGroup as GroupSnapshot;
        const identity = toCanonicalRtcTopologyGroupIdentity(group.group);
        validateAffectedGroupAgainstReceipt(group, receipt);
        if (
            receipt.outboxIds[index] !==
                toRtcRttTopologyOutboxId(receipt.receiptId, group.group, receipt.commandHash)
        ) {
            throw new TypeError('RTC RTT affected group differs from receipt outbox identity');
        }
        observed.push(identity);
    }
    if (!rtcTopologySemanticEqual(observed, expectedGroups)) {
        throw new TypeError('RTC RTT affected groups are not canonical');
    }
}

function validateMeasurementGuard(
    value: JsonWireValue,
    receipt: RtcRttMutationReceipt
): Readonly<{ value: RttMeasurementInfo; purgeAfterEpochMs: number; }> {
    const guard = record(value, 'RTC RTT measurement guard');
    exactKeys(guard, ['expectedRevision', 'value', 'purgeAfterEpochMs']);
    validateExpectedRevision(guard.expectedRevision, 'measurement');
    validateRtcRttMeasurement(guard.value);
    const measurement = guard.value as RttMeasurementInfo;
    safeInteger(guard.purgeAfterEpochMs, receipt.acceptedAtEpochMs + 1, 'measurement purge time');
    if (
        measurement.sessionIdFrom !== receipt.sessionIdFrom ||
        measurement.sessionIdTo !== receipt.sessionIdTo ||
        measurement.version !== receipt.measurementVersion ||
        measurement.createdAtEpochMs > receipt.acceptedAtEpochMs
    ) {
        throw new TypeError('RTC RTT measurement guard differs from receipt');
    }
    return {
        value: measurement,
        purgeAfterEpochMs: guard.purgeAfterEpochMs as number
    };
}

function validateEndpointGuards(
    value: JsonWireValue,
    receipt: RtcRttMutationReceipt,
    purgeAfterEpochMs: number
): void {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError('RTC RTT endpoint guard pair is incomplete');
    }
    const expectedEndpointIds = [receipt.sessionIdFrom, receipt.sessionIdTo].sort(
        compareRtcTopologyIdentifiers
    );
    for (let index = 0; index < value.length; index += 1) {
        const guard = record(value[index], 'RTC RTT endpoint guard');
        exactKeys(guard, ['endpointId', 'expectedRevision', 'expireAtTimestamp', 'value']);
        const endpointId = guard.endpointId;
        nonEmptyString(endpointId, 'endpoint guard id');
        if (endpointId !== expectedEndpointIds[index]) {
            throw new TypeError('RTC RTT endpoint guards are not canonical');
        }
        validateExpectedRevision(guard.expectedRevision, 'endpoint');
        safeInteger(guard.expireAtTimestamp, receipt.acceptedAtEpochMs + 1, 'endpoint guard expiry');
        validateRtcRttEndpointAdmission(guard.value, endpointId, guard.expireAtTimestamp as number);
        const admission = guard.value as RtcRttEndpointAdmission;
        validateRtcRttEndpointAdmissionCandidateVersion(admission.version, guard.expectedRevision);
        if (admission.updatedAtEpochMs !== receipt.acceptedAtEpochMs) {
            throw new TypeError('RTC RTT endpoint admission lifecycle is invalid');
        }
        const counterpart = endpointId === receipt.sessionIdFrom ? receipt.sessionIdTo : receipt.sessionIdFrom;
        const pairLease = admission.peers.find((peer) => peer.peerSessionId === counterpart);
        if (!pairLease || pairLease.expiresAtEpochMs < purgeAfterEpochMs) {
            throw new TypeError('RTC RTT endpoint admission is missing pair lease');
        }
    }
}

function validateAffectedGroupAgainstReceipt(
    group: GroupSnapshot,
    receipt: RtcRttMutationReceipt
): void {
    const groupIdentity = toCanonicalRtcTopologyGroupIdentity(group.group);
    const receiptIncludesGroup = receipt.affectedGroupRefs.some(
        (ref) => toCanonicalRtcTopologyGroupIdentity(ref) === groupIdentity
    );
    const activeSessionIds = new Set(
        group.activeSessions
            .filter(
                (session) =>
                    session.connectedAtEpochMs <= receipt.acceptedAtEpochMs &&
                    session.expiresAtEpochMs > receipt.acceptedAtEpochMs
            )
            .map((session) => session.sessionId)
    );
    const groupExpiry = group.group.expiresAtEpochMs;
    if (
        !receiptIncludesGroup ||
        group.group.status !== 'active' ||
        (groupExpiry !== null && groupExpiry <= receipt.acceptedAtEpochMs) ||
        !activeSessionIds.has(receipt.sessionIdFrom) ||
        !activeSessionIds.has(receipt.sessionIdTo)
    ) {
        throw new TypeError('RTC RTT affected group differs from immutable receipt authority');
    }
}

function validateExpectedRevision(
    value: JsonWireValue,
    authority: string
): asserts value is number | null {
    if (value === null) {
        return;
    }
    if (
        !Number.isSafeInteger(value) ||
        Object.is(value, -0) ||
        (value as number) < 0 ||
        (value as number) >= Number.MAX_SAFE_INTEGER
    ) {
        throw new TypeError(`RTC RTT ${authority} expected revision is invalid`);
    }
}

function record(value: JsonWireValue, label: string): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as JsonWireObject;
}

function exactKeys(value: JsonWireObject, expected: readonly string[]): void {
    const keys = Object.keys(value).sort(compareRtcTopologyIdentifiers);
    const canonical = [...expected].sort(compareRtcTopologyIdentifiers);
    if (!rtcTopologySemanticEqual(keys, canonical)) {
        throw new TypeError('RTC RTT persisted fields are invalid');
    }
}

function nonEmptyString(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}

function safeInteger(value: JsonWireValue, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}
