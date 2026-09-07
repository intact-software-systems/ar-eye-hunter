import { type RtcTopologyPublicationWorkClaim } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../persistence/decode-rtc-topology-snapshot.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../persistence/rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import { compareTopologyTuple, decideTopologySnapshot } from '../persistence/rtc-topology-snapshot-contract.ts';
import type { RtcTopologyPublication } from '../publication/rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from '../publication/validate-rtc-topology-publication.ts';
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
            }>
            | Readonly<{
                publication: null;
                publicationExpireAtTimestamp: null;
            }>
        )
    );
export interface RtcTopologyMutationValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export function computeTopologyMutation(
    input: RtcTopologyMutationInput
): RtcTopologyMutationComputed {
    if (input.read.publicationClaim) {
        return computeLoadedTopologyPublication(input);
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
    assertPublicationExpiryFact(input.publication, input.facts);
    const write = {
        outcome: 'write',
        observation,
        persistence: computeRtcTopologyPersistence({
            snapshot: input.candidate,
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            publication: input.publication,
            ...input.facts
        }),
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
    if (
        publicationExpireAtTimestamp === null || input.facts.commandHash === null || input.facts.attemptCount === null
    ) {
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

function computeLoadedTopologyPublication(input: RtcTopologyMutationInput): RtcTopologyMutationComputed {
    if (!input.read.publicationClaim) {
        throw new TypeError('RTC topology replay requires a publication claim');
    }
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
    const publicationValidation = validatePublicationSelfConsistent(storedPublication);
    if ('issue' in publicationValidation) {
        throw publicationValidation.issue.cause;
    }
    const publicationSnapshot = publicationValidation.snapshot;
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

function validatePublicationSelfConsistent(
    publication: RtcTopologyPublication
): Readonly<{ snapshot: RallarOverlayTopologySnapshot; }> | Readonly<{ issue: RtcTopologyMutationValidationIssue; }> {
    try {
        validateRtcTopologyPublication(publication, publication.groupRef);
        const snapshot = decodeRtcTopologySnapshot(
            decodeJsonWireValue(
                publication.snapshot,
                'RTC topology publication snapshot'
            ),
            publication.groupRef
        );
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
            const message = 'RTC topology publication winner is internally inconsistent';
            return {
                issue: { path: 'publication', message, cause: new TypeError(message) }
            };
        }
        return { snapshot };
    }
    catch (error) {
        const cause = error instanceof Error
            ? error
            : new TypeError('RTC topology publication payload snapshot is invalid');
        return {
            issue: { path: 'publication', message: cause.message, cause }
        };
    }
}

export function validateTopologyMutation(
    input:
        & RtcTopologyMutationInput
        & Readonly<{
            computed: RtcTopologyMutationComputed;
        }>
): readonly RtcTopologyMutationValidationIssue[] {
    const recomputed = computeTopologyMutation(input);
    const issues: RtcTopologyMutationValidationIssue[] = [
        ...validateComputedProjection(recomputed, input.computed, 'computed')
    ];
    if (input.candidate === null) {
        return issues;
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
        const message = 'RTC topology publication differs from candidate identity';
        issues.push({ path: 'publication', message, cause: new TypeError(message) });
    }
    if (input.publication && ['write', 'publish-superseded'].includes(input.computed.outcome)) {
        const publicationValidation = validatePublicationSelfConsistent(input.publication);
        if ('issue' in publicationValidation) {
            issues.push(publicationValidation.issue);
        }
        else if (!rtcTopologySemanticEqual(publicationValidation.snapshot, input.candidate)) {
            const message = 'RTC topology publication payload differs from candidate';
            issues.push({ path: 'publication.snapshot', message, cause: new TypeError(message) });
        }
    }
    return issues;
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

function assertPublicationExpiryFact(
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
