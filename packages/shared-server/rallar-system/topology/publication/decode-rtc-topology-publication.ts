import { decodeALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { decodeJsonWireValue, type JsonWireObject } from '../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../persistence/decode-rtc-topology-snapshot.ts';
import {
    toRtcTopologyPublicationId
} from '../persistence/rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';

/** Why a stored publication cannot be used: `unsupported` predates envelope version 4, `malformed` is corrupt. */
export interface RtcTopologyPublicationRefusal {
    readonly code: 'unsupported' | 'malformed';
    readonly message: string;
}

const PRE_V4_PUBLICATION_KEYS = [
    'publicationId',
    'workId',
    'groupRef',
    'sourceGroupStateCausalRevision',
    'overlayVersion',
    'targetGroupSnapshotVersion',
    'recipientSessionIds',
    'snapshot',
    'expiresAtEpochMs',
    'createdAtEpochMs'
] as const;

const PUBLICATION_KEYS = [...PRE_V4_PUBLICATION_KEYS, 'traceId'] as const;

/** Strict decode of an authoritative persisted publication; a pre-v4 row is refused as `unsupported`. */
export function decodeRtcTopologyPublication(
    value: unknown,
    expectedRef: GroupRef
): Either<RtcTopologyPublicationRefusal, RtcTopologyPublication> {
    try {
        const publication = decodePublicationRecord(value, 'RTC topology publication');
        if (hasExactKeys(publication, PRE_V4_PUBLICATION_KEYS)) {
            return Either.ofLeft({
                code: 'unsupported',
                message: 'RTC topology publication predates AL envelope version 4'
            });
        }
        assertPublicationFields(publication, expectedRef);
        return Either.ofRight(value as RtcTopologyPublication);
    }
    catch (error) {
        return Either.ofLeft({
            code: 'malformed',
            message: error instanceof TypeError ? error.message : 'RTC topology publication is invalid'
        });
    }
}

/** Programmer invariant for a publication this process built or already decoded. */
export function assertRtcTopologyPublication(
    value: RtcTopologyPublication,
    expectedRef: GroupRef
): void {
    decodeRtcTopologyPublication(value, expectedRef).fold((refusal) => {
        throw new TypeError(refusal.message);
    }, () => undefined);
}

function assertPublicationFields(publication: JsonWireObject, expectedRef: GroupRef): void {
    exactKeys(publication, PUBLICATION_KEYS);
    assertExactGroupRef(publication.groupRef, expectedRef);
    nonEmptyString(publication.publicationId, 'publication id');
    nonEmptyString(publication.workId, 'work id');
    if (decodeALTraceId(publication.traceId).left !== undefined) {
        throw new TypeError('RTC topology publication trace is invalid');
    }
    const overlayVersion = publication.overlayVersion;
    const targetGroupSnapshotVersion = publication.targetGroupSnapshotVersion;
    const createdAtEpochMs = publication.createdAtEpochMs;
    safeInteger(overlayVersion, 0, 'overlayVersion');
    safeInteger(targetGroupSnapshotVersion, 0, 'targetGroupSnapshotVersion');
    safeInteger(createdAtEpochMs, 0, 'createdAtEpochMs');
    causalRevision(publication.sourceGroupStateCausalRevision);
    if (
        publication.publicationId !== toRtcTopologyPublicationId({
            workId: publication.workId,
            sourceGroupStateCausalRevision: publication.sourceGroupStateCausalRevision,
            overlayVersion
        })
    ) {
        throw new TypeError('RTC topology publication id is not deterministic');
    }
    if (
        !Array.isArray(publication.recipientSessionIds) ||
        publication.recipientSessionIds.some((sessionId) => typeof sessionId !== 'string' || sessionId.length === 0)
    ) {
        throw new TypeError('RTC topology publication recipients are invalid');
    }
    safeInteger(publication.expiresAtEpochMs, createdAtEpochMs + 1, 'expiresAtEpochMs');
    assertPublicationSnapshot(publication, expectedRef);
}

function assertPublicationSnapshot(publication: JsonWireObject, expectedRef: GroupRef): void {
    const snapshot = decodeRtcTopologySnapshot(
        decodeJsonWireValue(publication.snapshot, 'RTC topology publication snapshot'),
        expectedRef
    );
    if (
        !rtcTopologySemanticEqual(
            snapshot.sourceGroupStateCausalRevision,
            publication.sourceGroupStateCausalRevision
        ) ||
        snapshot.version !== publication.overlayVersion ||
        !rtcTopologySemanticEqual(snapshot.activeSessionIds, publication.recipientSessionIds)
    ) {
        throw new TypeError('RTC topology publication winner is internally inconsistent');
    }
}

function assertExactGroupRef(value: unknown, expected: GroupRef): asserts value is GroupRef {
    const ref = decodePublicationRecord(value, 'RTC topology publication group ref');
    exactKeys(ref, ['applicationId', 'workspaceId', 'groupId']);
    nonEmptyString(ref.applicationId, 'group application id');
    nonEmptyString(ref.workspaceId, 'group workspace id');
    nonEmptyString(ref.groupId, 'group id');
    if (!sameGroupRef(ref as GroupRef, expected)) {
        throw new TypeError('RTC topology publication group ref differs');
    }
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function decodePublicationRecord(value: unknown, label: string): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as JsonWireObject;
}

function exactKeys(
    value: JsonWireObject,
    expected: readonly string[]
): void {
    if (!hasExactKeys(value, expected)) {
        throw new TypeError('RTC topology publication fields are invalid');
    }
}

function hasExactKeys(value: JsonWireObject, expected: readonly string[]): boolean {
    return rtcTopologySemanticEqual(Object.keys(value).sort(), [...expected].sort());
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC topology ${label} is invalid`);
    }
}

function safeInteger(
    value: unknown,
    minimum: number,
    label: string
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`RTC topology ${label} is invalid`);
    }
}

function causalRevision(
    value: unknown
): asserts value is GroupStateCausalRevision {
    const revision = decodePublicationRecord(value, 'RTC topology source causal revision');
    exactKeys(revision, ['groupRevision', 'presenceRevision']);
    safeInteger(revision.groupRevision, 0, 'source group revision');
    safeInteger(revision.presenceRevision, 0, 'source presence revision');
}
