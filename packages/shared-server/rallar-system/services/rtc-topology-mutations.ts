import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type { RtcTopologyPublicationWorkClaim } from '../repositories/RtcTopologyPublicationRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import type { RtcTopologyPublication } from '../rtc-topology-publication-contract.ts';
import { validateRtcTopologyPublication } from '../rtc-topology-publication-validation.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import {
    compareTopologyTuple,
    decideTopologySnapshot,
    validateTopologySnapshot
} from '../rtc-topology-snapshot-contract.ts';
import { computeStaleTopologyPublication } from './rtc-topology-stale-publication.ts';
import type { RtcTopologyStaleMutationComputed } from './rtc-topology-stale-publication.ts';

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
        reason: 'publication-ahead-of-snapshot' | 'incomparable-causal-revision';
    }>
    | RtcTopologyStaleMutationComputed
    | (
        & Readonly<{
            outcome: 'write';
            observation: 'inserted' | 'advanced' | 'duplicate';
            snapshotGuard: Readonly<{
                expectedRevision: number | null;
                candidate: RallarOverlayTopologySnapshot;
            }>;
        }>
        & (
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
    input: RtcTopologyMutationInput
): RtcTopologyMutationComputed {
    if (input.read.publicationClaim) {
        if (
            input.candidate !== null ||
            input.publication !== null ||
            input.facts.publicationExpireAtTimestamp !== null ||
            input.facts.commandHash !== null ||
            input.facts.attemptCount !== null
        ) {
            throw new TypeError(
                'RTC topology publication replay must not include mutable planning input'
            );
        }
        if (!input.read.snapshot) {
            throw new TypeError('RTC topology publication claim has no durable snapshot');
        }
        const storedPublication = input.read.publicationClaim.publication;
        const storedSnapshot = input.read.snapshot.value;
        const publicationSnapshot = assertPublicationSelfConsistent(storedPublication);
        const relation = compareTopologyTuple(publicationSnapshot, storedSnapshot);
        if (relation === 'dominates') {
            return {
                outcome: 'retry',
                reason: 'publication-ahead-of-snapshot'
            };
        }
        if (relation === 'equal' && !rtcTopologySemanticEqual(publicationSnapshot, storedSnapshot)) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                storedPublication.publicationId,
                'RTC topology publication equal causal tuple differs from durable snapshot'
            );
        }
        if (relation === 'incomparable') {
            return {
                outcome: 'retry',
                reason: 'incomparable-causal-revision'
            };
        }
        return {
            outcome: 'loaded',
            snapshot: storedSnapshot,
            publication: storedPublication
        };
    }

    if (input.candidate === null) {
        throw new TypeError('RTC topology publication claim miss requires a candidate snapshot');
    }
    const current = input.read.snapshot?.value;
    const observation = decideTopologySnapshot(current, input.candidate);
    if (observation === 'stale') {
        return computeStaleTopologyPublication({
            current: input.read.snapshot!,
            publication: input.publication,
            ...input.facts
        });
    }
    if (observation === 'incomparable') {
        return {
            outcome: 'retry',
            reason: 'incomparable-causal-revision'
        };
    }
    validatePublicationExpiryFact(input.publication, input.facts);
    const write = {
        outcome: 'write',
        observation,
        snapshotGuard: {
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            candidate: input.candidate
        }
    } as const;
    if (input.publication === null) {
        return {
            ...write,
            publication: null,
            publicationExpireAtTimestamp: null
        };
    }
    const publicationExpireAtTimestamp = input.facts.publicationExpireAtTimestamp;
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
        attemptCount: input.facts.attemptCount
    };
}

function assertPublicationSelfConsistent(
    publication: RtcTopologyPublication
): RallarOverlayTopologySnapshot {
    validateRtcTopologyPublication(publication, publication.groupRef);
    let payload: unknown;
    try {
        payload = JSON.parse(publication.message.payload.resource);
    }
    catch {
        throw new TypeError('RTC topology publication payload snapshot is invalid');
    }
    validateTopologySnapshot(payload, publication.groupRef);
    const snapshot = payload;
    if (
        !snapshot.groupRef ||
        !sameGroupRef(publication.groupRef, snapshot.groupRef) ||
        !rtcTopologySemanticEqual(
            publication.sourceGroupStateCausalRevision,
            snapshot.sourceGroupStateCausalRevision
        ) ||
        publication.overlayVersion !== snapshot.version ||
        !rtcTopologySemanticEqual(publication.recipientSessionIds, snapshot.activeSessionIds)
    ) {
        throw new TypeError('RTC topology publication winner is internally inconsistent');
    }
    return snapshot;
}

export function validateTopologyMutation(
    input:
        & RtcTopologyMutationInput
        & Readonly<{
            computed: RtcTopologyMutationComputed;
        }>
): void {
    const recomputed = computeTopologyMutation(input);
    if (!rtcTopologySemanticEqual(recomputed, input.computed)) {
        throw new TypeError('RTC topology mutation differs from canonical computation');
    }
    if (input.candidate === null) {
        return;
    }
    if (
        input.publication &&
        (!sameGroupRef(input.publication.groupRef, input.candidate.groupRef) ||
            !rtcTopologySemanticEqual(
                input.publication.sourceGroupStateCausalRevision,
                input.candidate.sourceGroupStateCausalRevision
            ) ||
            input.publication.overlayVersion !== input.candidate.version)
    ) {
        throw new TypeError('RTC topology publication differs from candidate identity');
    }
    if (input.publication && ['write', 'publish-superseded'].includes(input.computed.outcome)) {
        const publicationSnapshot = assertPublicationSelfConsistent(input.publication);
        if (!rtcTopologySemanticEqual(publicationSnapshot, input.candidate)) {
            throw new TypeError('RTC topology publication payload differs from candidate');
        }
    }
}

function sameGroupRef(
    left: RtcTopologyPublication['groupRef'],
    right: RtcTopologyPublication['groupRef']
): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}

function validatePublicationExpiryFact(
    publication: RtcTopologyPublication | null,
    facts: RtcTopologyMutationFacts
): void {
    const expiresAt = facts.publicationExpireAtTimestamp;
    if (publication === null) {
        if (expiresAt !== null || facts.commandHash !== null || facts.attemptCount !== null) {
            throw new TypeError('RTC topology publication expiry must be null without publication');
        }
        return;
    }
    if (
        expiresAt === null ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= publication.createdAtEpochMs ||
        typeof facts.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(facts.commandHash) ||
        !Number.isSafeInteger(facts.attemptCount) ||
        facts.attemptCount < 1
    ) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
}
