import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type {
    GroupRef,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    toRtcTopologyPublicationId,
    toRtcTopologyPublicationMessageId,
} from './rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication-contract.ts';
import { validateTopologySnapshot } from './rtc-topology-snapshot-contract.ts';
import { rtcTopologySemanticEqual } from './rtc-topology-semantic-equality.ts';
import { validatePersistedALMessage } from './services/al-message-persistence-validation.ts';

/** Strict synchronous validation for an authoritative persisted publication. */
export function validateRtcTopologyPublication(
    value: unknown,
    expectedRef: GroupRef,
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
        'message',
        'createdAtEpochMs',
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
            sourceGroupStateCausalRevision:
                publication.sourceGroupStateCausalRevision,
            overlayVersion,
        })
    ) {
        throw new TypeError('RTC topology publication id is not deterministic');
    }
    if (
        !Array.isArray(publication.recipientSessionIds) ||
        publication.recipientSessionIds.some((sessionId) =>
            typeof sessionId !== 'string' || sessionId.length === 0
        )
    ) {
        throw new TypeError('RTC topology publication recipients are invalid');
    }
    validatePersistedALMessage(publication.message);
    const message = publication.message;
    let snapshot: unknown;
    try {
        snapshot = JSON.parse(message.payload.resource);
    } catch {
        throw new TypeError('RTC topology publication message snapshot is invalid');
    }
    validateTopologySnapshot(snapshot, expectedRef);
    validateEnvelope(
        message,
        expectedRef,
        snapshot,
        targetGroupSnapshotVersion,
        createdAtEpochMs,
    );
    if (
        message.id.msgId !==
            toRtcTopologyPublicationMessageId(publication.workId)
    ) {
        throw new TypeError('RTC topology publication message id is not deterministic');
    }
    if (
        !rtcTopologySemanticEqual(
            snapshot.sourceGroupStateCausalRevision,
            publication.sourceGroupStateCausalRevision,
        ) ||
        snapshot.version !== publication.overlayVersion ||
        !rtcTopologySemanticEqual(
            snapshot.activeSessionIds,
            publication.recipientSessionIds,
        )
    ) {
        throw new TypeError(
            'RTC topology publication winner is internally inconsistent',
        );
    }
}

function validateEnvelope(
    message: ALMessage,
    expectedRef: GroupRef,
    snapshot: RallarOverlayTopologySnapshot,
    targetGroupSnapshotVersion: number,
    createdAtEpochMs: number,
): void {
    if (!message.targets || !message.delivery || !message.audit) {
        throw new TypeError(
            'RTC topology publication is missing mandatory envelope sections',
        );
    }
    const expectedResourceId =
        `${snapshot.overlayId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:` +
        `${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`;
    if (
        message.targets.mode !== 'broadcast' ||
        message.targets.minSnapshotVersion !== targetGroupSnapshotVersion
    ) {
        throw new TypeError(
            'RTC topology publication target snapshot version is invalid',
        );
    }
    if (
        message.id.senderId !== 'rallar-server' ||
        message.route.topicId !== AppTopics.overlayTopology ||
        message.route.contextId !== expectedRef.groupId ||
        message.route.resourceId !== expectedResourceId ||
        message.payload.typeId !== AppTopics.overlayTopology ||
        message.payload.contentType !== 'application/json' ||
        message.targets.mode !== 'broadcast' ||
        message.targets.scope !== 'room' ||
        message.targets.groupRef === undefined ||
        !sameGroupRef(message.targets.groupRef, expectedRef) ||
        message.delivery.reliability !== 'best-effort' ||
        message.delivery.ack !== 'none' ||
        message.audit.createdBy !== 'rallar-server' ||
        message.audit.createdTs !== createdAtEpochMs ||
        message.id.ts !== createdAtEpochMs
    ) {
        throw new TypeError(
            'RTC topology publication envelope identity or timestamp is invalid',
        );
    }
}

function validateExactGroupRef(value: unknown, expected: GroupRef): void {
    const ref = record(value, 'RTC topology publication group ref');
    exactKeys(
        ref,
        expected.workspaceId === undefined
            ? ['applicationId', 'groupId']
            : ['applicationId', 'workspaceId', 'groupId'],
    );
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
    expected: readonly string[],
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
    label: string,
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`RTC topology ${label} is invalid`);
    }
}

function causalRevision(
    value: unknown,
): asserts value is GroupStateCausalRevision {
    const revision = record(value, 'RTC topology source causal revision');
    exactKeys(revision, ['groupRevision', 'presenceRevision']);
    safeInteger(revision.groupRevision, 0, 'source group revision');
    safeInteger(revision.presenceRevision, 0, 'source presence revision');
}
