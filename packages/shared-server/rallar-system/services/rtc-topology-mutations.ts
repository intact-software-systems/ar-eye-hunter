import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../runtime-state/RuntimeStateRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../rtc-topology-publication-contract.ts';
import type { RtcTopologyPublicationWorkClaim } from '../repositories/RtcTopologyPublicationRepository.ts';
import { validateRtcTopologyPublication } from '../rtc-topology-publication-validation.ts';
import {
    compareTopologyTuple,
    decideTopologySnapshot,
    validateTopologySnapshot,
} from '../rtc-topology-snapshot-contract.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    RTC_RTT_MUTATION_RETENTION_MS,
    validateRtcRttWriteCandidate,
} from '../rtc-rtt-persistence-validation.ts';
import { computeStaleTopologyPublication } from './rtc-topology-stale-publication.ts';
import type { RtcTopologyStaleMutationComputed } from './rtc-topology-stale-publication.ts';
import {
    evaluateRtcRttMeasurement,
    type RtcRttAcceptanceReason,
} from './rtc-rtt-measurement-policy.ts';
import {
    canonicalRtcRttAffectedGroups as canonicalAffectedGroups,
    canonicalRtcRttGroupRef as canonicalGroupRef,
    readRtcRttExpiredAuthority,
} from './rtc-rtt-expired-authority.ts';

export type RtcTopologyPublicationClaim = Readonly<{
    receipt: RtcTopologyPublicationWorkClaim;
    publication: RtcTopologyPublication;
}>;
export type RtcTopologyMutationRead = Readonly<{
    snapshot: RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | null;
    publicationClaim: RtcTopologyPublicationClaim | null;
}>;
export type RtcTopologyMutationInput = Readonly<{
    read: RtcTopologyMutationRead;
    candidate: RallarOverlayTopologySnapshot | null;
    publication: RtcTopologyPublication | null;
    facts: RtcTopologyMutationFacts;
}>;
export type RtcTopologyMutationFacts =
    | Readonly<{
        publicationExpireAtTimestamp: null;
        commandHash: null;
        attemptCount: null;
    }>
    | Readonly<{
        publicationExpireAtTimestamp: number;
        commandHash: string;
        attemptCount: number;
    }>;
export type RtcTopologyMutationComputed =
    | Readonly<{
        outcome: 'loaded';
        snapshot: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>
    | Readonly<{
        outcome: 'retry';
        reason:
            | 'publication-ahead-of-snapshot'
            | 'incomparable-causal-revision';
    }>
    | RtcTopologyStaleMutationComputed
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
                commandHash: string;
                attemptCount: number;
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
        if (
            input.candidate !== null || input.publication !== null ||
            input.facts.publicationExpireAtTimestamp !== null ||
            input.facts.commandHash !== null || input.facts.attemptCount !== null
        ) {
            throw new TypeError(
                'RTC topology publication replay must not include mutable planning input',
            );
        }
        if (!input.read.snapshot) {
            throw new TypeError(
                'RTC topology publication claim has no durable snapshot',
            );
        }
        const storedPublication = input.read.publicationClaim.publication;
        const storedSnapshot = input.read.snapshot.value;
        const publicationSnapshot = assertPublicationSelfConsistent(storedPublication);
        const relation = compareTopologyTuple(publicationSnapshot, storedSnapshot);
        if (relation === 'dominates') {
            return {
                outcome: 'retry',
                reason: 'publication-ahead-of-snapshot',
            };
        }
        if (
            relation === 'equal' &&
            !rtcTopologySemanticEqual(publicationSnapshot, storedSnapshot)
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                storedPublication.publicationId,
                'RTC topology publication equal causal tuple differs from durable snapshot',
            );
        }
        if (relation === 'incomparable') {
            return {
                outcome: 'retry',
                reason: 'incomparable-causal-revision',
            };
        }
        return {
            outcome: 'loaded',
            snapshot: storedSnapshot,
            publication: storedPublication,
        };
    }

    if (input.candidate === null) {
        throw new TypeError(
            'RTC topology publication claim miss requires a candidate snapshot',
        );
    }
    const current = input.read.snapshot?.value;
    const observation = decideTopologySnapshot(current, input.candidate);
    if (observation === 'stale') {
        return computeStaleTopologyPublication({
            current: input.read.snapshot!,
            publication: input.publication,
            ...input.facts,
        });
    }
    if (observation === 'incomparable') {
        return {
            outcome: 'retry',
            reason: 'incomparable-causal-revision',
        };
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
    if (input.facts.commandHash === null || input.facts.attemptCount === null) {
        throw new TypeError('RTC topology execution receipt facts are invalid');
    }
    return {
        ...write,
        publication: input.publication,
        publicationExpireAtTimestamp,
        commandHash: input.facts.commandHash,
        attemptCount: input.facts.attemptCount,
    };
}

function assertPublicationSelfConsistent(
    publication: RtcTopologyPublication,
): RallarOverlayTopologySnapshot {
    validateRtcTopologyPublication(publication, publication.groupRef);
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
        !rtcTopologySemanticEqual(
            publication.sourceGroupStateCausalRevision,
            snapshot.sourceGroupStateCausalRevision,
        ) ||
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
    if (input.candidate === null) return;
    if (
        input.publication &&
        (!sameGroupRef(input.publication.groupRef, input.candidate.groupRef) ||
            !rtcTopologySemanticEqual(
                input.publication.sourceGroupStateCausalRevision,
                input.candidate.sourceGroupStateCausalRevision,
            ) ||
            input.publication.overlayVersion !== input.candidate.version)
    ) {
        throw new TypeError('RTC topology publication differs from candidate identity');
    }
    if (
        input.publication &&
        ['write', 'publish-superseded'].includes(input.computed.outcome)
    ) {
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
        expiredMeasurementEntry: RuntimeStateEntry | null;
        endpointAdmissions: readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[];
        expiredEndpointAdmissionEntries: readonly RuntimeStateEntry[];
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
    commandId: string;
    requestId: string;
    sessionIdFrom: string;
    sessionIdTo: string;
    aggregateRef: Readonly<{ sessionIdFrom: string; sessionIdTo: string }>;
    measurementVersion: number;
    affectedGroupRefs: readonly GroupRef[];
    acceptedAtEpochMs: number;
    outcome: 'accepted';
    attemptCount: number;
    acceptedStorageRevision: number;
    eventId: null;
    outboxIds: readonly string[];
    commandHash: string;
}>;

type RtcRttRecomputeIntentBase = Readonly<{
    outboxId: string;
    receiptId: string;
    groupSnapshot: GroupSnapshot;
    rtt: RttMeasurementInfo;
    createdAtEpochMs: number;
    commandHash: string;
    senderId: string;
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
    const { admissionByEndpoint, expiredAdmissionByEndpoint } =
        readRtcRttExpiredAuthority({
            ...authorityRead,
            sessionIdFrom: authority.command.rtt.sessionIdFrom,
            sessionIdTo: authority.command.rtt.sessionIdTo,
        });
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
            expectedRevision,
            expireAtTimestamp: Math.max(...peers.map((peer) => peer.expiresAtEpochMs)),
            value: {
                endpointId,
                peers,
                version: expectedRevision === null ? 1 : expectedRevision + 2,
                updatedAtEpochMs: authority.facts.requestedAtEpochMs,
            },
        };
    });
    const receiptId = toRtcRttMutationReceiptId(authority.command.rtt);
    const affectedGroupRefs = affectedGroups.map((group) =>
        canonicalGroupRef(group.group)
    );
    const recomputeIntents = affectedGroups.map((group): RtcRttRecomputeIntent => ({
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
        senderId: authority.command.alSenderId,
        delivery: { state: 'pending' },
    }));
    return {
        outcome: 'write',
        reason: 'accepted',
        affectedGroups,
        endpointGuards,
        measurementGuard: {
            expectedRevision: authorityRead.measurement?.entry.revision ??
                authorityRead.expiredMeasurementEntry?.revision ?? null,
            value: authority.command.rtt,
            purgeAfterEpochMs: authority.facts.purgeAfterEpochMs,
        },
        receipt: {
            receiptId,
            commandId: receiptId,
            requestId: receiptId,
            sessionIdFrom: authority.command.rtt.sessionIdFrom,
            sessionIdTo: authority.command.rtt.sessionIdTo,
            aggregateRef: {
                sessionIdFrom: authority.command.rtt.sessionIdFrom,
                sessionIdTo: authority.command.rtt.sessionIdTo,
            },
            measurementVersion: authority.command.rtt.version,
            affectedGroupRefs,
            acceptedAtEpochMs: authority.facts.requestedAtEpochMs,
            outcome: 'accepted',
            attemptCount: input.facts.attemptCount,
            acceptedStorageRevision:
                (authorityRead.measurement?.entry.revision ??
                    authorityRead.expiredMeasurementEntry?.revision ?? -1) + 1,
            eventId: null,
            outboxIds: recomputeIntents.map((intent) => intent.outboxId),
            commandHash: input.facts.commandHash,
        },
        recomputeIntents,
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
        validateRtcRttWriteCandidate(
            input.computed,
            input.computed.receipt.acceptedAtEpochMs +
                RTC_RTT_MUTATION_RETENTION_MS,
        );
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
    if (!Number.isSafeInteger(facts.attemptCount) || facts.attemptCount < 1) {
        throw new TypeError('RTC RTT attempt count fact is invalid');
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
        if (
            expiresAt !== null || facts.commandHash !== null ||
            facts.attemptCount !== null
        ) {
            throw new TypeError(
                'RTC topology publication expiry must be null without publication',
            );
        }
        return;
    }
    if (
        expiresAt === null || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= publication.createdAtEpochMs ||
        typeof facts.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(facts.commandHash) ||
        !Number.isSafeInteger(facts.attemptCount) || facts.attemptCount < 1
    ) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
}
