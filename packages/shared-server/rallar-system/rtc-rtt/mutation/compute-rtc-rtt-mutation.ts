import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    encodeRuntimeStateJsonValue,
    type RuntimeStateEntryValue
} from '../../../runtime-state/runtime-state-json-store.ts';

import { computeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { computeRtcTopologyEntry } from '../../topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../topology/persistence/rtc-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../../topology/persistence/rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../topology/persistence/rtc-topology-semantic-equal.ts';
import type { RtcRttEndpointAdmission } from '../persistence/rtc-rtt-persistence-contracts.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '../persistence/rtc-rtt-persistence-validation-primitives.ts';
import {
    RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
    RTC_RTT_LATEST_NAMESPACE,
    RTC_RTT_RECEIPTS_NAMESPACE
} from '../persistence/rtc-rtt-runtime-namespaces.ts';
import {
    toRtcRttEndpointAdmissionStorageKey,
    toRtcRttMeasurementStorageKey
} from '../persistence/rtc-rtt-storage-keys.ts';
import {
    canonicalRtcRttAffectedGroups,
    canonicalRtcRttGroupRef,
    readRtcRttExpiredAuthority
} from '../policy/read-rtc-rtt-expired-authority.ts';
import { evaluateRtcRttMeasurement } from '../policy/rtc-rtt-measurement-policy.ts';
import {
    assertReceiptOnlyRttInputs,
    requireRttAuthority,
    validateRtcRttMutationFacts
} from './rtc-rtt-mutation-authority.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationRead
} from './rtc-rtt-mutation-contracts.ts';
import { toRtcRttMutationReceiptId, toRtcRttTopologyOutboxId } from './rtc-rtt-mutation-identifiers.ts';

export class RtcRttMutationIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'rtc-rtt-idempotency-conflict';

    readonly receiptId: string;

    constructor(receiptId: string) {
        super(`RTC RTT receipt ${receiptId} was already claimed by another command`);
        this.receiptId = receiptId;
        this.name = 'RtcRttMutationIdempotencyConflictError';
    }
}

export function computeRtcRttMutation(
    input: Readonly<{
        command: RtcRttMutationCommand;
        read: RtcRttMutationRead;
        facts: RtcRttMutationFacts;
    }>
): RtcRttMutationComputed {
    validateRtcRttMutationFacts(input.facts);
    if (input.read.receipt) {
        assertReceiptOnlyRttInputs(input.command, input.facts);
        if (input.read.receipt.value.commandHash !== input.facts.commandHash) {
            throw new RtcRttMutationIdempotencyConflictError(input.read.receipt.value.receiptId);
        }
        return {
            outcome: 'replay',
            reason: 'accepted',
            affectedGroups: [],
            receipt: input.read.receipt.value
        };
    }
    const authorityRead = input.read as Extract<RtcRttMutationRead, { receipt: null; }>;
    const authority = requireRttAuthority(input.command, input.facts);
    const { admissionByEndpoint, expiredAdmissionByEndpoint } = readRtcRttExpiredAuthority({
        ...authorityRead,
        sessionIdFrom: authority.command.rtt.sessionIdFrom,
        sessionIdTo: authority.command.rtt.sessionIdTo
    });
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version > authority.command.rtt.version
    ) {
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: []
        };
    }
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version === authority.command.rtt.version
    ) {
        if (!sameMeasurement(authorityRead.measurement.value, authority.command.rtt)) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                authorityRead.measurement.entry.key,
                'RTC RTT equal version differs from durable measurement'
            );
        }
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: []
        };
    }

    const acceptance = evaluateRtcRttMeasurement({
        ...authority.command,
        requestedAtEpochMs: authority.facts.requestedAtEpochMs,
        existingMeasurements: authorityRead.measurements.map(({ value }) => value)
    });
    const affectedGroups = canonicalRtcRttAffectedGroups(acceptance.affectedGroups);
    if (!acceptance.accepted) {
        return {
            outcome: 'rejected',
            reason: acceptance.reason,
            affectedGroups
        };
    }

    if (
        exceedsEndpointAdmissionDegree({
            rtt: authority.command.rtt,
            admissions: admissionByEndpoint,
            degreeLimit: authority.command.degreeLimit,
            requestedAtEpochMs: authority.facts.requestedAtEpochMs
        })
    ) {
        return {
            outcome: 'rejected',
            reason: 'over-degree',
            affectedGroups
        };
    }

    const endpoints = [
        ...new Set([authority.command.rtt.sessionIdFrom, authority.command.rtt.sessionIdTo])
    ].sort(compareRtcTopologyIdentifiers);
    const endpointGuards = endpoints.map((endpointId) => {
        const stored = admissionByEndpoint.get(endpointId);
        const expired = expiredAdmissionByEndpoint.get(endpointId);
        const expectedRevision = stored?.entry.revision ?? expired?.revision ?? null;
        const peerExpiry = new Map<string, number>();
        for (const peer of stored?.value.peers ?? []) {
            if (peer.expiresAtEpochMs > authority.facts.requestedAtEpochMs) {
                peerExpiry.set(peer.peerSessionId, peer.expiresAtEpochMs);
            }
        }
        for (const peer of peersForEndpoint(endpointId, authorityRead.measurements)) {
            peerExpiry.set(
                peer.peerSessionId,
                Math.max(peerExpiry.get(peer.peerSessionId) ?? 0, peer.expiresAtEpochMs)
            );
        }
        const incomingPeer = endpointId === authority.command.rtt.sessionIdFrom
            ? authority.command.rtt.sessionIdTo
            : authority.command.rtt.sessionIdFrom;
        peerExpiry.set(
            incomingPeer,
            Math.max(peerExpiry.get(incomingPeer) ?? 0, authority.facts.purgeAfterEpochMs)
        );
        const peers = [...peerExpiry]
            .map(([peerSessionId, expiresAtEpochMs]) => ({
                peerSessionId,
                expiresAtEpochMs
            }))
            .sort((left, right) => compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId));
        return {
            endpointId,
            expectedRevision,
            expireAtTimestamp: Math.max(...peers.map((peer) => peer.expiresAtEpochMs)),
            value: {
                endpointId,
                peers,
                version: expectedRevision === null ? 1 : expectedRevision + 2,
                updatedAtEpochMs: authority.facts.requestedAtEpochMs
            }
        };
    });
    const receiptId = toRtcRttMutationReceiptId(authority.command.rtt);
    const affectedGroupRefs = affectedGroups.map((group) => canonicalRtcRttGroupRef(group.group));
    const outboxIds = affectedGroups.map((group) =>
        toRtcRttTopologyOutboxId(receiptId, group.group, input.facts.commandHash)
    );
    const measurementGuard = {
        expectedRevision: authorityRead.measurement?.entry.revision ??
            authorityRead.expiredMeasurementEntry?.revision ??
            null,
        value: authority.command.rtt,
        purgeAfterEpochMs: authority.facts.purgeAfterEpochMs
    };
    const receipt = {
        receiptId,
        commandId: receiptId,
        requestId: receiptId,
        sessionIdFrom: authority.command.rtt.sessionIdFrom,
        sessionIdTo: authority.command.rtt.sessionIdTo,
        aggregateRef: {
            sessionIdFrom: authority.command.rtt.sessionIdFrom,
            sessionIdTo: authority.command.rtt.sessionIdTo
        },
        measurementVersion: authority.command.rtt.version,
        affectedGroupRefs,
        acceptedAtEpochMs: authority.facts.requestedAtEpochMs,
        outcome: 'accepted',
        attemptCount: input.facts.attemptCount,
        acceptedStorageRevision: (authorityRead.measurement?.entry.revision ??
            authorityRead.expiredMeasurementEntry?.revision ??
            -1) + 1,
        eventId: null,
        outboxIds,
        commandHash: input.facts.commandHash
    } as const;
    const computed = {
        affectedGroups,
        endpointGuards,
        measurementGuard,
        receipt,
        senderId: authority.command.alSenderId
    };
    const writes = computeRtcRttWrites(computed);
    return {
        outcome: 'write',
        reason: 'accepted',
        ...computed,
        ...writes
    };
}

function computeRtcRttWrites(
    computed: Omit<
        Extract<RtcRttMutationComputed, { outcome: 'write'; }>,
        'outcome' | 'reason' | 'runtimeWrites' | 'outboxWrites'
    >
): ComputedRtcRttWrites {
    const mutationExpireAtTimestamp = computed.receipt.acceptedAtEpochMs +
        RTC_RTT_MUTATION_RETENTION_MS;
    const runtimeWrites = computed.endpointGuards.map((guard) => ({
        namespace: RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE,
        key: toRtcRttEndpointAdmissionStorageKey(guard.value.endpointId),
        value: encodeRuntimeStateJsonValue(guard.value),
        expireAtIsoTimestamp: new Date(guard.expireAtTimestamp).toISOString(),
        expectedRevision: guard.expectedRevision
    }));
    return {
        runtimeWrites: [
            ...runtimeWrites,
            {
                namespace: RTC_RTT_LATEST_NAMESPACE,
                key: toRtcRttMeasurementStorageKey(
                    computed.measurementGuard.value.sessionIdFrom,
                    computed.measurementGuard.value.sessionIdTo
                ),
                value: encodeRuntimeStateJsonValue(computed.measurementGuard.value),
                expireAtIsoTimestamp: new Date(
                    computed.measurementGuard.purgeAfterEpochMs
                ).toISOString(),
                expectedRevision: computed.measurementGuard.expectedRevision
            },
            {
                namespace: RTC_RTT_RECEIPTS_NAMESPACE,
                key: computed.receipt.receiptId,
                value: encodeRuntimeStateJsonValue(computed.receipt),
                expireAtIsoTimestamp: new Date(mutationExpireAtTimestamp).toISOString(),
                expectedRevision: null
            }
        ],
        outboxWrites: computed.affectedGroups.map((group, index) =>
            computeAppOutboxInsert(computeRtcTopologyEntry({
                commandId: computed.receipt.receiptId,
                resourceId: computed.receipt.outboxIds[index]!,
                aggregateRef: group.group,
                acceptedCausalRevision: group.causalRevision,
                groupSnapshot: group,
                effectKind: 'rtc-topology-recompute',
                payloadKind: 'rtt-refresh',
                rtt: computed.measurementGuard.value,
                refinementObservationId: computed.receipt.receiptId,
                createdAtEpochMs: computed.receipt.acceptedAtEpochMs,
                expireAtEpochMs: mutationExpireAtTimestamp,
                senderId: computed.senderId,
                requestOptions: toCanonicalGroupTopologyConfigPatch({}),
                publish: true
            }))
        )
    };
}

interface ComputedRtcRttWrites {
    readonly runtimeWrites: Extract<RtcRttMutationComputed, { outcome: 'write'; }>['runtimeWrites'];
    readonly outboxWrites: Extract<RtcRttMutationComputed, { outcome: 'write'; }>['outboxWrites'];
}

interface ExceedsEndpointAdmissionDegreeInput {
    readonly rtt: RttMeasurementInfo;
    readonly admissions: ReadonlyMap<string, RuntimeStateEntryValue<RtcRttEndpointAdmission>>;
    readonly degreeLimit: number;
    readonly requestedAtEpochMs: number;
}

function exceedsEndpointAdmissionDegree(input: ExceedsEndpointAdmissionDegreeInput): boolean {
    for (
        const [endpointId, incomingPeerId] of [
            [input.rtt.sessionIdFrom, input.rtt.sessionIdTo],
            [input.rtt.sessionIdTo, input.rtt.sessionIdFrom]
        ] as const
    ) {
        const peers = new Set(
            (input.admissions.get(endpointId)?.value.peers ?? [])
                .filter((peer) => peer.expiresAtEpochMs > input.requestedAtEpochMs)
                .map((peer) => peer.peerSessionId)
        );
        if (!peers.has(incomingPeerId) && peers.size >= input.degreeLimit) {
            return true;
        }
    }
    return false;
}

function peersForEndpoint(
    endpointId: string,
    measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[]
): readonly Readonly<{ peerSessionId: string; expiresAtEpochMs: number; }>[] {
    const peers = new Map<string, number>();
    for (const measurement of measurements) {
        const peerSessionId = measurement.value.sessionIdFrom === endpointId
            ? measurement.value.sessionIdTo
            : measurement.value.sessionIdTo === endpointId
            ? measurement.value.sessionIdFrom
            : undefined;
        if (peerSessionId) {
            peers.set(
                peerSessionId,
                Math.max(peers.get(peerSessionId) ?? 0, measurement.entry.expireAtTimestamp)
            );
        }
    }
    return [...peers]
        .map(([peerSessionId, expiresAtEpochMs]) => ({
            peerSessionId,
            expiresAtEpochMs
        }))
        .sort((left, right) => compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId));
}

function sameMeasurement(left: RttMeasurementInfo, right: RttMeasurementInfo): boolean {
    return (
        left.sessionIdFrom === right.sessionIdFrom &&
        left.sessionIdTo === right.sessionIdTo &&
        left.rttMs === right.rttMs &&
        left.createdAtEpochMs === right.createdAtEpochMs &&
        left.version === right.version
    );
}
