import type { RtcTopologyPublicationWorkClaim } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { assertRuntimeStateUpsertExpectedRevision } from '../../../runtime-state/runtime-state-repository.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../persistence/decode-rtc-topology-snapshot.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../persistence/rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import {
    compareTopologyTuple,
    decideTopologySnapshot,
    type RtcTopologySnapshotObservation
} from '../persistence/rtc-topology-snapshot-contract.ts';
import type { RtcTopologyPublication } from '../publication/rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from '../publication/validate-rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationDelivery,
    type RtcTopologyPublicationDeliveryComputed
} from '../replay/delivery/rtc-topology-delivery-validation.ts';
import {
    computeRtcTopologyPersistence,
    type RtcTopologyPersistenceComputed
} from './compute-rtc-topology-persistence.ts';
import { computeStaleTopologyPublication } from './rtc-topology-stale-publication.ts';
import type { RtcTopologyStaleMutationComputed } from './rtc-topology-stale-publication.ts';

export interface RtcTopologyPublicationClaim {
    readonly receipt: RtcTopologyPublicationWorkClaim;
    readonly publication: RtcTopologyPublication;
}
export interface RtcTopologyMutationRead {
    readonly snapshot: RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | null;
    readonly publicationClaim: RtcTopologyPublicationClaim | null;
}
export interface RtcTopologyMutationInput {
    readonly read: RtcTopologyMutationRead;
    readonly candidate: RallarOverlayTopologySnapshot | null;
    readonly publication: RtcTopologyPublication | null;
    readonly facts: RtcTopologyMutationFacts;
    readonly deliveryPublisherStreamId: string | null;
}
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
        publicationDelivery: RtcTopologyPublicationDeliveryComputed;
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
            persistence: RtcTopologyPersistenceComputed;
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
                publicationDelivery: RtcTopologyPublicationDeliveryComputed;
            }>
            | Readonly<{
                publication: null;
                publicationExpireAtTimestamp: null;
                publicationDelivery: null;
            }>
        )
    );
export function computeTopologyMutation(
    input: RtcTopologyMutationInput
): RtcTopologyMutationComputed {
    if (input.read.publicationClaim) {
        return computeTopologyPublicationReplay(input, input.read.publicationClaim);
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
            deliveryPublisherStreamId: input.deliveryPublisherStreamId,
            ...input.facts
        });
    }
    if (observation === 'incomparable') {
        return {
            outcome: 'retry',
            reason: 'incomparable-causal-revision'
        };
    }
    return computeTopologySnapshotWrite(input, input.candidate, observation);
}

function computeTopologyPublicationReplay(
    input: RtcTopologyMutationInput,
    publicationClaim: RtcTopologyPublicationClaim
): RtcTopologyMutationComputed {
    if (
        input.candidate !== null ||
        input.publication !== null ||
        input.facts.publicationExpireAtTimestamp !== null ||
        input.facts.commandHash !== null ||
        input.facts.attemptCount !== null
    ) {
        throw new TypeError('RTC topology publication replay must not include mutable planning input');
    }
    if (!input.read.snapshot) {
        throw new TypeError('RTC topology publication claim has no durable snapshot');
    }
    const storedPublication = publicationClaim.publication;
    const storedSnapshot = input.read.snapshot.value;
    const publicationSnapshot = assertPublicationSelfConsistent(storedPublication);
    const relation = compareTopologyTuple(publicationSnapshot, storedSnapshot);
    if (relation === 'dominates') {
        return { outcome: 'retry', reason: 'publication-ahead-of-snapshot' };
    }
    if (relation === 'equal' && !rtcTopologySemanticEqual(publicationSnapshot, storedSnapshot)) {
        throw new RtcTopologyRepositoryInvariantCorruptionError(
            storedPublication.publicationId,
            'RTC topology publication equal causal tuple differs from durable snapshot'
        );
    }
    if (relation === 'incomparable') {
        return { outcome: 'retry', reason: 'incomparable-causal-revision' };
    }
    return {
        outcome: 'loaded',
        snapshot: storedSnapshot,
        publication: storedPublication,
        publicationDelivery: computeRtcTopologyPublicationDelivery(storedPublication, input.deliveryPublisherStreamId)
    };
}

function computeTopologySnapshotWrite(
    input: RtcTopologyMutationInput,
    candidate: RallarOverlayTopologySnapshot,
    observation: Exclude<RtcTopologySnapshotObservation, 'stale' | 'incomparable'>
): RtcTopologyMutationComputed {
    validatePublicationExpiryFact(input.publication, input.facts);
    const write = {
        outcome: 'write',
        observation,
        persistence: computeRtcTopologyPersistence({
            snapshot: candidate,
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            publication: input.publication,
            ...input.facts
        }),
        snapshotGuard: {
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            candidate
        }
    } as const;
    if (input.publication === null) {
        return {
            ...write,
            publication: null,
            publicationExpireAtTimestamp: null,
            publicationDelivery: null
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
        attemptCount: input.facts.attemptCount,
        publicationDelivery: computeRtcTopologyPublicationDelivery(
            input.publication,
            input.deliveryPublisherStreamId
        )
    };
}

function assertPublicationSelfConsistent(
    publication: RtcTopologyPublication
): RallarOverlayTopologySnapshot {
    validateRtcTopologyPublication(publication, publication.groupRef);
    let payload: RallarOverlayTopologySnapshot;
    try {
        payload = decodeRtcTopologySnapshot(
            decodeJsonWireValue(
                JSON.parse(publication.message.payload.resource),
                'RTC topology publication snapshot'
            ),
            publication.groupRef
        );
    }
    catch {
        throw new TypeError('RTC topology publication payload snapshot is invalid');
    }
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
    const issues = validateAppInboxComputedProjection(recomputed, input.computed, 'topology mutation');
    if (issues.length > 0) {
        throw new TypeError('RTC topology mutation differs from canonical computation');
    }
    if (recomputed.outcome === 'write' || recomputed.outcome === 'publish-superseded') {
        const expectedRevision = recomputed.persistence.snapshot.expectedRevision;
        if (expectedRevision !== null) {
            assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        }
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
