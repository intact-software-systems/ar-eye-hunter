import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../rtc-topology-publication-contract.ts';
import {
    compareTopologyTuple,
    decideTopologySnapshot,
    validateTopologySnapshot,
} from '../rtc-topology-snapshot-contract.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    evaluateRtcRttMeasurement,
    type RtcRttAcceptanceReason,
} from './rtc-rtt-measurement-policy.ts';

export type RtcTopologyPublicationClaim = Readonly<{
    publication: RtcTopologyPublication;
}>;

export type RtcTopologyMutationRead = Readonly<{
    snapshot: RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | null;
    publicationClaim: RtcTopologyPublicationClaim | null;
}>;

export type RtcTopologyMutationInput = Readonly<{
    read: RtcTopologyMutationRead;
    candidate: RallarOverlayTopologySnapshot;
    publication: RtcTopologyPublication | null;
    facts: RtcTopologyMutationFacts;
}>;

export type RtcTopologyMutationFacts = Readonly<{
    publicationExpireAtTimestamp: number | null;
}>;

export type RtcTopologyMutationComputed =
    | Readonly<{
        outcome: 'loaded';
        snapshot: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>
    | Readonly<{
        outcome: 'retry';
        reason: 'publication-ahead-of-snapshot';
    }>
    | Readonly<{
        outcome: 'superseded';
        current: RallarOverlayTopologySnapshot;
    }>
    | (
        Readonly<{
            outcome: 'write';
            observation: 'inserted' | 'advanced' | 'duplicate';
            snapshotGuard: Readonly<{
                expectedRevision: number | null;
                candidate: RallarOverlayTopologySnapshot;
            }>;
        }> & (
            | Readonly<{
                publication: RtcTopologyPublication;
                publicationExpireAtTimestamp: number;
            }>
            | Readonly<{
                publication: null;
                publicationExpireAtTimestamp: null;
            }>
        )
    );

export function computeTopologyMutation(
    input: RtcTopologyMutationInput,
): RtcTopologyMutationComputed {
    if (input.read.publicationClaim) {
        if (!input.read.snapshot) {
            throw new TypeError(
                'RTC topology publication claim has no durable snapshot',
            );
        }
        const storedPublication = input.read.publicationClaim.publication;
        const storedSnapshot = input.read.snapshot.value;
        const publicationSnapshot = assertPublicationSelfConsistent(storedPublication);
        const relation = compareTopologyTuple(publicationSnapshot, storedSnapshot);
        if (relation > 0) {
            return {
                outcome: 'retry',
                reason: 'publication-ahead-of-snapshot',
            };
        }
        if (
            relation === 0 &&
            !rtcTopologySemanticEqual(publicationSnapshot, storedSnapshot)
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                storedPublication.publicationId,
                'RTC topology publication equal causal tuple differs from durable snapshot',
            );
        }
        return {
            outcome: 'loaded',
            snapshot: storedSnapshot,
            publication: storedPublication,
        };
    }

    const current = input.read.snapshot?.value;
    const observation = decideTopologySnapshot(current, input.candidate);
    if (observation === 'stale') {
        return { outcome: 'superseded', current: current! };
    }
    validatePublicationExpiryFact(input.publication, input.facts);
    const write = {
        outcome: 'write',
        observation,
        snapshotGuard: {
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            candidate: input.candidate,
        },
    } as const;
    if (input.publication === null) {
        return {
            ...write,
            publication: null,
            publicationExpireAtTimestamp: null,
        };
    }
    const publicationExpireAtTimestamp =
        input.facts.publicationExpireAtTimestamp;
    if (publicationExpireAtTimestamp === null) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
    return {
        ...write,
        publication: input.publication,
        publicationExpireAtTimestamp,
    };
}

function assertPublicationSelfConsistent(
    publication: RtcTopologyPublication,
): RallarOverlayTopologySnapshot {
    let payload: unknown;
    try {
        payload = JSON.parse(publication.message.payload.resource);
    } catch {
        throw new TypeError('RTC topology publication payload snapshot is invalid');
    }
    validateTopologySnapshot(payload, publication.groupRef);
    const snapshot = payload;
    if (
        !snapshot.groupRef ||
        !sameGroupRef(publication.groupRef, snapshot.groupRef) ||
        publication.sourceGroupStateRevision !== snapshot.sourceGroupStateRevision ||
        publication.overlayVersion !== snapshot.version ||
        !rtcTopologySemanticEqual(
            publication.recipientSessionIds,
            snapshot.activeSessionIds,
        )
    ) {
        throw new TypeError('RTC topology publication winner is internally inconsistent');
    }
    return snapshot;
}

export function validateTopologyMutation(
    input: RtcTopologyMutationInput & Readonly<{
        computed: RtcTopologyMutationComputed;
    }>,
): void {
    const recomputed = computeTopologyMutation(input);
    if (!rtcTopologySemanticEqual(recomputed, input.computed)) {
        throw new TypeError('RTC topology mutation differs from canonical computation');
    }
    if (
        input.publication &&
        (!sameGroupRef(input.publication.groupRef, input.candidate.groupRef) ||
            input.publication.sourceGroupStateRevision !==
                input.candidate.sourceGroupStateRevision ||
            input.publication.overlayVersion !== input.candidate.version)
    ) {
        throw new TypeError('RTC topology publication differs from candidate identity');
    }
    if (input.publication && input.computed.outcome === 'write') {
        const publicationSnapshot = assertPublicationSelfConsistent(input.publication);
        if (!rtcTopologySemanticEqual(publicationSnapshot, input.candidate)) {
            throw new TypeError('RTC topology publication payload differs from candidate');
        }
    }
}

export type RtcRttEndpointAdmission = Readonly<{
    endpointId: string;
    peers: readonly Readonly<{
        peerSessionId: string;
        expiresAtEpochMs: number;
    }>[];
    version: number;
    updatedAtEpochMs: number;
}>;

export type RtcRttStableRequest = Readonly<{
    rtt: RttMeasurementInfo;
    alSenderId: string;
}>;

export type RtcRttMutationCommand = RtcRttStableRequest & (
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
        endpointAdmissions: readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[];
        measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[];
    }>;

export type RtcRttMutationFacts = (
    | Readonly<{
        purgeAfterEpochMs: null;
        requestedAtEpochMs: null;
    }>
    | RtcRttMutationLifecycleFacts
) & Readonly<{
    commandHash: string;
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
        recomputeIntents: readonly RtcRttRecomputeIntent[];
    }>;

export type RtcRttMutationReceipt = Readonly<{
    receiptId: string;
    sessionIdFrom: string;
    sessionIdTo: string;
    measurementVersion: number;
    affectedGroupRefs: readonly GroupRef[];
    acceptedAtEpochMs: number;
    outcome: 'accepted';
    commandHash: string;
}>;

type RtcRttRecomputeIntentBase = Readonly<{
    outboxId: string;
    receiptId: string;
    groupSnapshot: GroupSnapshot;
    rtt: RttMeasurementInfo;
    createdAtEpochMs: number;
    commandHash: string;
}>;

export type RtcRttRecomputeIntent = RtcRttRecomputeIntentBase & (
    | Readonly<{
        delivery: Readonly<{ state: 'pending' }>;
    }>
    | Readonly<{
        delivery: Readonly<{
            state: 'delivered';
            deliveredAtEpochMs: number;
        }>;
    }>
);

export class RtcRttMutationIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'rtc-rtt-idempotency-conflict';

    constructor(readonly receiptId: string) {
        super(`RTC RTT receipt ${receiptId} was already claimed by another command`);
        this.name = 'RtcRttMutationIdempotencyConflictError';
    }
}

export function computeRttMutation(input: Readonly<{
    command: RtcRttMutationCommand;
    read: RtcRttMutationRead;
    facts: RtcRttMutationFacts;
}>): RtcRttMutationComputed {
    validateRttMutationFacts(input.facts);
    if (input.read.receipt) {
        assertReceiptOnlyRttInputs(input.command, input.facts);
        if (input.read.receipt.value.commandHash !== input.facts.commandHash) {
            throw new RtcRttMutationIdempotencyConflictError(
                input.read.receipt.value.receiptId,
            );
        }
        return {
            outcome: 'replay',
            reason: 'accepted',
            affectedGroups: [],
            receipt: input.read.receipt.value,
        };
    }
    const authorityRead = input.read as Extract<
        RtcRttMutationRead,
        { receipt: null }
    >;
    const authority = requireRttAuthority(input.command, input.facts);
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version > authority.command.rtt.version
    ) {
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: [],
        };
    }
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version === authority.command.rtt.version
    ) {
        if (!sameMeasurement(authorityRead.measurement.value, authority.command.rtt)) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                authorityRead.measurement.entry.key,
                'RTC RTT equal version differs from durable measurement',
            );
        }
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: [],
        };
    }

    const acceptance = evaluateRtcRttMeasurement({
        ...authority.command,
        requestedAtEpochMs: authority.facts.requestedAtEpochMs,
        existingMeasurements: authorityRead.measurements.map(({ value }) => value),
    });
    const affectedGroups = canonicalAffectedGroups(acceptance.affectedGroups);
    if (!acceptance.accepted) {
        return {
            outcome: 'rejected',
            reason: acceptance.reason,
            affectedGroups,
        };
    }

    const admissionByEndpoint = new Map(
        authorityRead.endpointAdmissions.map((stored) => [stored.value.endpointId, stored]),
    );
    if (exceedsEndpointAdmissionDegree(
        authority.command.rtt,
        admissionByEndpoint,
        authority.command.degreeLimit,
        authority.facts.requestedAtEpochMs,
    )) {
        return {
            outcome: 'rejected',
            reason: 'over-degree',
            affectedGroups,
        };
    }

    const endpoints = [...new Set([
        authority.command.rtt.sessionIdFrom,
        authority.command.rtt.sessionIdTo,
    ])].sort(compareRtcTopologyIdentifiers);
    const endpointGuards = endpoints.map((endpointId) => {
        const stored = admissionByEndpoint.get(endpointId);
        const peerExpiry = new Map<string, number>();
        for (const peer of stored?.value.peers ?? []) {
            if (peer.expiresAtEpochMs > authority.facts.requestedAtEpochMs) {
                peerExpiry.set(peer.peerSessionId, peer.expiresAtEpochMs);
            }
        }
        for (const peer of peersForEndpoint(endpointId, authorityRead.measurements)) {
            peerExpiry.set(
                peer.peerSessionId,
                Math.max(peerExpiry.get(peer.peerSessionId) ?? 0, peer.expiresAtEpochMs),
            );
        }
        const incomingPeer = endpointId === authority.command.rtt.sessionIdFrom
            ? authority.command.rtt.sessionIdTo
            : authority.command.rtt.sessionIdFrom;
        peerExpiry.set(
            incomingPeer,
            Math.max(
                peerExpiry.get(incomingPeer) ?? 0,
                authority.facts.purgeAfterEpochMs,
            ),
        );
        const peers = [...peerExpiry].map(([peerSessionId, expiresAtEpochMs]) => ({
            peerSessionId,
            expiresAtEpochMs,
        })).sort((left, right) =>
            compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId)
        );
        return {
            endpointId,
            expectedRevision: stored?.entry.revision ?? null,
            expireAtTimestamp: Math.max(...peers.map((peer) => peer.expiresAtEpochMs)),
            value: {
                endpointId,
                peers,
                version: (stored?.value.version ?? 0) + 1,
                updatedAtEpochMs: authority.facts.requestedAtEpochMs,
            },
        };
    });
    const receiptId = toRtcRttMutationReceiptId(authority.command.rtt);
    const affectedGroupRefs = affectedGroups.map((group) =>
        canonicalGroupRef(group.group)
    );
    return {
        outcome: 'write',
        reason: 'accepted',
        affectedGroups,
        endpointGuards,
        measurementGuard: {
            expectedRevision: authorityRead.measurement?.entry.revision ?? null,
            value: authority.command.rtt,
            purgeAfterEpochMs: authority.facts.purgeAfterEpochMs,
        },
        receipt: {
            receiptId,
            sessionIdFrom: authority.command.rtt.sessionIdFrom,
            sessionIdTo: authority.command.rtt.sessionIdTo,
            measurementVersion: authority.command.rtt.version,
            affectedGroupRefs,
            acceptedAtEpochMs: authority.facts.requestedAtEpochMs,
            outcome: 'accepted',
            commandHash: input.facts.commandHash,
        },
        recomputeIntents: affectedGroups.map((group) => ({
            outboxId: toRtcRttRecomputeOutboxId(
                receiptId,
                group.group,
                input.facts.commandHash,
            ),
            receiptId,
            groupSnapshot: group,
            rtt: authority.command.rtt,
            createdAtEpochMs: authority.facts.requestedAtEpochMs,
            commandHash: input.facts.commandHash,
            delivery: { state: 'pending' },
        })),
    };
}

function exceedsEndpointAdmissionDegree(
    rtt: RttMeasurementInfo,
    admissions: ReadonlyMap<
        string,
        RuntimeStateEntryValue<RtcRttEndpointAdmission>
    >,
    degreeLimit: number,
    requestedAtEpochMs: number,
): boolean {
    for (const [endpointId, incomingPeerId] of [
        [rtt.sessionIdFrom, rtt.sessionIdTo],
        [rtt.sessionIdTo, rtt.sessionIdFrom],
    ] as const) {
        const peers = new Set(
            (admissions.get(endpointId)?.value.peers ?? [])
                .filter((peer) => peer.expiresAtEpochMs > requestedAtEpochMs)
                .map((peer) => peer.peerSessionId),
        );
        if (!peers.has(incomingPeerId) && peers.size >= degreeLimit) return true;
    }
    return false;
}

export function validateRttMutation(input: Readonly<{
    command: RtcRttMutationCommand;
    read: RtcRttMutationRead;
    facts: RtcRttMutationFacts;
    computed: RtcRttMutationComputed;
}>): void {
    const recomputed = computeRttMutation(input);
    if (!rtcTopologySemanticEqual(recomputed, input.computed)) {
        throw new TypeError('RTC RTT mutation differs from canonical computation');
    }
    if (input.computed.outcome === 'write') {
        const endpointIds = input.computed.endpointGuards.map((guard) => guard.endpointId);
        if (
            !rtcTopologySemanticEqual(
                endpointIds,
                [...endpointIds].sort(compareRtcTopologyIdentifiers),
            )
        ) {
            throw new TypeError('RTC RTT endpoint guards are not in lexical order');
        }
    }
}

export function validateRttMutationFacts(facts: RtcRttMutationFacts): void {
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('RTC RTT command hash fact is invalid');
    }
    if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
        if (facts.requestedAtEpochMs !== null || facts.purgeAfterEpochMs !== null) {
            throw new TypeError('RTC RTT lifecycle facts must be jointly absent');
        }
        return;
    }
    if (
        !Number.isSafeInteger(facts.requestedAtEpochMs) ||
        facts.requestedAtEpochMs < 0
    ) {
        throw new TypeError('RTC RTT requested-at lifecycle fact is invalid');
    }
    if (
        !Number.isSafeInteger(facts.purgeAfterEpochMs) ||
        facts.purgeAfterEpochMs <= facts.requestedAtEpochMs
    ) {
        throw new TypeError('RTC RTT purge-after lifecycle fact is invalid');
    }
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return ref.workspaceId === undefined
        ? { applicationId: ref.applicationId, groupId: ref.groupId }
        : {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
        };
}

function canonicalAffectedGroups(
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

function assertReceiptOnlyRttInputs(
    command: RtcRttMutationCommand,
    facts: RtcRttMutationFacts,
): void {
    if (
        command.candidateGroups !== null ||
        command.overlaySnapshotsByGroupKey !== null ||
        command.degreeLimit !== null ||
        facts.requestedAtEpochMs !== null ||
        facts.purgeAfterEpochMs !== null
    ) {
        throw new TypeError('RTC RTT receipt replay must not include authority or lifecycle facts');
    }
}

function requireRttAuthority(
    command: RtcRttMutationCommand,
    facts: RtcRttMutationFacts,
): Readonly<{
    command: RtcRttStableRequest & Readonly<{
        candidateGroups: readonly GroupSnapshot[];
        overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
        degreeLimit: number;
    }>;
    facts: RtcRttMutationLifecycleFacts & Readonly<{ commandHash: string }>;
}> {
    if (
        command.candidateGroups === null ||
        command.overlaySnapshotsByGroupKey === null ||
        command.degreeLimit === null ||
        facts.requestedAtEpochMs === null ||
        facts.purgeAfterEpochMs === null
    ) {
        throw new TypeError('RTC RTT receipt miss requires authority and lifecycle facts');
    }
    return {
        command: command as RtcRttStableRequest & Readonly<{
            candidateGroups: readonly GroupSnapshot[];
            overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
            degreeLimit: number;
        }>,
        facts: facts as RtcRttMutationLifecycleFacts & Readonly<{ commandHash: string }>,
    };
}


function peersForEndpoint(
    endpointId: string,
    measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[],
): readonly Readonly<{ peerSessionId: string; expiresAtEpochMs: number }>[] {
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
                Math.max(
                    peers.get(peerSessionId) ?? 0,
                    measurement.entry.expireAtTimestamp,
                ),
            );
        }
    }
    return [...peers].map(([peerSessionId, expiresAtEpochMs]) => ({
        peerSessionId,
        expiresAtEpochMs,
    })).sort((left, right) =>
        compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId)
    );
}

function sameGroupRef(
    left: RtcTopologyPublication['groupRef'],
    right: RtcTopologyPublication['groupRef'],
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
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

function validatePublicationExpiryFact(
    publication: RtcTopologyPublication | null,
    facts: RtcTopologyMutationFacts,
): void {
    const expiresAt = facts.publicationExpireAtTimestamp;
    if (publication === null) {
        if (expiresAt !== null) {
            throw new TypeError(
                'RTC topology publication expiry must be null without publication',
            );
        }
        return;
    }
    if (
        expiresAt === null || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= publication.createdAtEpochMs
    ) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
}
