import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../persistence/decode-rtc-topology-snapshot.ts';
import {
    toRtcTopologyPublicationId
} from '../persistence/rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';

/** Strict synchronous validation for an authoritative persisted publication. */
export function validateRtcTopologyPublication(
    value: unknown,
    expectedRef: GroupRef
): asserts value is RtcTopologyPublication {
    const publication = record(value, 'RTC topology publication');
    exactKeys(publication, [
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
    ]);
    validateExactGroupRef(publication.groupRef, expectedRef);
    nonEmptyString(publication.publicationId, 'publication id');
    nonEmptyString(publication.workId, 'work id');
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
    const snapshot = decodeRtcTopologySnapshot(
        decodeJsonWireValue(publication.snapshot, 'RTC topology publication snapshot'),
        expectedRef
    );
    safeInteger(publication.expiresAtEpochMs, createdAtEpochMs + 1, 'expiresAtEpochMs');
    if (
        !rtcTopologySemanticEqual(
            snapshot.sourceGroupStateCausalRevision,
            publication.sourceGroupStateCausalRevision
        ) ||
        snapshot.version !== overlayVersion ||
        !rtcTopologySemanticEqual(snapshot.activeSessionIds, publication.recipientSessionIds)
    ) {
        throw new TypeError('RTC topology publication winner is internally inconsistent');
    }
}

function validateExactGroupRef(value: unknown, expected: GroupRef): void {
    const ref = record(value, 'RTC topology publication group ref');
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

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(
    value: Record<string, unknown>,
    expected: readonly string[]
): void {
    const keys = Object.keys(value).sort();
    const canonical = [...expected].sort();
    if (!rtcTopologySemanticEqual(keys, canonical)) {
        throw new TypeError('RTC topology publication fields are invalid');
    }
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
    const revision = record(value, 'RTC topology source causal revision');
    exactKeys(revision, ['groupRevision', 'presenceRevision']);
    safeInteger(revision.groupRevision, 0, 'source group revision');
    safeInteger(revision.presenceRevision, 0, 'source presence revision');
}
