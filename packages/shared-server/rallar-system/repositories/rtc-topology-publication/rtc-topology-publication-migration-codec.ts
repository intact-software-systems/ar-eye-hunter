import type { GroupRef } from '@shared/api/group-types.ts';

import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { toRtcTopologyPublicationMessageId } from '../../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../../rtc-topology-publication-contract.ts';
import { validateRtcTopologyPublication } from '../../rtc-topology-publication-validation.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import { validateTopologySnapshot } from '../../rtc-topology-snapshot-contract.ts';
import { validatePersistedALMessage } from '../../services/al-message-persistence-validation.ts';
import {
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    type RtcTopologyPublicationWorkClaim
} from './rtc-topology-publication-repository-contracts.ts';
import {
    assertExactKeys,
    isRecord,
    parseValue,
    publicationCorruption,
    validateGroupRef,
    validateWorkClaim,
    type PersistedBoundaryValue
} from './rtc-topology-publication-repository-state.ts';
import type { RtcTopologyPublicationRepository } from './rtc-topology-publication-repository.ts';

interface ValidateCompletedPublicationMigrationInput {
    readonly transaction: RuntimeStateOptimisticTransactionalRepositoryLike;
    readonly repository: RtcTopologyPublicationRepository;
    readonly publication: RtcTopologyPublication;
    readonly expectedClaim: RtcTopologyPublicationWorkClaim;
    readonly sourceIsCanonical: boolean;
    readonly expectedExpireAtTimestamp: number;
}

export async function validateCompletedPublicationMigration(
    input: ValidateCompletedPublicationMigrationInput
): Promise<void> {
    const {
        transaction,
        repository,
        publication,
        expectedClaim,
        sourceIsCanonical,
        expectedExpireAtTimestamp
    } = input;
    if (sourceIsCanonical) {
        throw publicationCorruption(
            publication.publicationId,
            'Canonical publication disappeared during migration'
        );
    }
    const destinationPublicationKey = repository.publicationKey(
        publication.groupRef,
        publication.publicationId
    );
    const destinationClaimKey = repository.workIndexKey(
        publication.groupRef,
        publication.workId
    );
    const [destinationPublication, destinationClaim, legacyClaim] = await Promise.all([
        transaction.findEntry(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, destinationPublicationKey),
        transaction.findEntry(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, destinationClaimKey),
        transaction.findEntry(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, publication.workId)
    ]);
    if (!destinationPublication || !destinationClaim || legacyClaim) {
        throw publicationCorruption(
            publication.publicationId,
            'Concurrent publication migration did not leave one complete canonical winner'
        );
    }
    if (
        destinationPublication.expireAtTimestamp !== expectedExpireAtTimestamp ||
        destinationClaim.expireAtTimestamp !== expectedExpireAtTimestamp
    ) {
        throw publicationCorruption(
            publication.publicationId,
            'Concurrent publication migration winner physical expiry differs from source'
        );
    }
    if (!readWorkClaimForMigration(destinationClaim, expectedClaim)) {
        throw publicationCorruption(
            destinationClaim.key,
            'Concurrent publication migration left a legacy work claim'
        );
    }
    const destinationValue = readPublicationForMigration(destinationPublication);
    if (
        !rtcTopologySemanticEqual(destinationValue, publication) ||
        !rtcTopologySemanticEqual(parseValue(destinationPublication), publication)
    ) {
        throw publicationCorruption(
            destinationPublication.key,
            'Concurrent publication migration destination differs from source'
        );
    }
}

export function readPublicationForMigration(entry: RuntimeStateEntry): RtcTopologyPublication {
    const raw = parseValue(entry);
    if (
        !isRecord(raw) ||
        typeof raw.publicationId !== 'string' ||
        typeof raw.workId !== 'string' ||
        !isRecord(raw.groupRef)
    ) {
        throw publicationCorruption(entry.key, 'Legacy publication is invalid');
    }
    try {
        return publicationForMigration(raw);
    }
    catch (error) {
        throw publicationCorruption(
            entry.key,
            error instanceof Error ? error.message : 'Legacy publication is invalid'
        );
    }
}

export function readWorkClaimForMigration(
    entry: RuntimeStateEntry,
    expected: RtcTopologyPublicationWorkClaim
): boolean {
    const raw = parseValue(entry);
    if (typeof raw === 'string') {
        if (raw !== expected.publicationId) {
            throw publicationCorruption(
                entry.key,
                'Legacy work claim differs from publication source'
            );
        }
        return false;
    }
    try {
        validateWorkClaim(raw, expected.groupRef);
        if (
            raw.workId !== expected.workId ||
            raw.publicationId !== expected.publicationId ||
            !rtcTopologySemanticEqual(raw, expected)
        ) {
            throw new TypeError('Canonical work claim differs from legacy source');
        }
        return true;
    }
    catch (canonicalError) {
        try {
            if (!isRecord(raw)) {
                throw canonicalError;
            }
            assertExactKeys(raw, ['groupRef', 'workId', 'publicationId']);
            validateGroupRef(raw.groupRef, expected.groupRef);
            if (
                raw.workId !== expected.workId ||
                raw.publicationId !== expected.publicationId
            ) {
                throw canonicalError;
            }
            return false;
        }
        catch (legacyError) {
            const error = legacyError === canonicalError ? canonicalError : legacyError;
            throw publicationCorruption(
                entry.key,
                error instanceof Error ? error.message : 'Legacy work claim is invalid'
            );
        }
    }
}

function publicationForMigration(
    raw: Record<string, PersistedBoundaryValue>
): RtcTopologyPublication {
    const hasTarget = Object.hasOwn(raw, 'targetGroupSnapshotVersion');
    const keys = [
        'publicationId',
        'workId',
        'groupRef',
        'sourceGroupStateCausalRevision',
        'overlayVersion',
        ...(hasTarget ? ['targetGroupSnapshotVersion'] : []),
        'recipientSessionIds',
        'message',
        'createdAtEpochMs'
    ];
    assertExactKeys(raw, keys);
    validatePersistedALMessage(raw.message);
    const message = raw.message;
    if (
        message.targets?.mode !== 'broadcast' ||
        message.targets.scope !== 'room' ||
        message.targets.minSnapshotVersion === undefined
    ) {
        throw new TypeError('Legacy RTC topology publication target is invalid');
    }
    let snapshot: PersistedBoundaryValue;
    try {
        snapshot = JSON.parse(message.payload.resource);
    }
    catch {
        throw new TypeError('Legacy RTC topology publication snapshot is invalid');
    }
    const groupRef = readMigrationGroupRef(raw.groupRef);
    validateTopologySnapshot(snapshot, groupRef);
    const targetGroupSnapshotVersion = hasTarget
        ? raw.targetGroupSnapshotVersion
        : message.targets.minSnapshotVersion;
    if (
        !Number.isSafeInteger(targetGroupSnapshotVersion) ||
        Number(targetGroupSnapshotVersion) < 0
    ) {
        throw new TypeError('Legacy RTC topology publication target is invalid');
    }
    if (targetGroupSnapshotVersion !== message.targets.minSnapshotVersion) {
        throw new TypeError('Legacy RTC topology publication target is inconsistent');
    }
    const workId = raw.workId;
    if (typeof workId !== 'string' || workId.length === 0) {
        throw new TypeError('Legacy RTC topology publication work id is invalid');
    }
    const createdAtEpochMs = raw.createdAtEpochMs;
    if (!Number.isSafeInteger(createdAtEpochMs) || Number(createdAtEpochMs) < 0) {
        throw new TypeError('Legacy RTC topology publication created time is invalid');
    }
    const candidate = {
        publicationId: raw.publicationId,
        workId,
        groupRef,
        sourceGroupStateCausalRevision: raw.sourceGroupStateCausalRevision,
        overlayVersion: raw.overlayVersion,
        targetGroupSnapshotVersion,
        recipientSessionIds: raw.recipientSessionIds,
        message: {
            ...message,
            id: {
                ...message.id,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs
            },
            audit: {
                ...message.audit,
                createdTs: createdAtEpochMs
            }
        },
        createdAtEpochMs
    };
    validateRtcTopologyPublication(candidate, groupRef);
    return canonicalPublication(candidate);
}

function canonicalPublication(
    publication: RtcTopologyPublication
): RtcTopologyPublication {
    const ref = publication.groupRef;
    return {
        ...publication,
        groupRef: {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId
        }
    };
}

function readMigrationGroupRef(value: PersistedBoundaryValue): GroupRef {
    if (!isRecord(value)) {
        throw new TypeError('Legacy RTC topology publication groupRef is invalid');
    }
    assertExactKeys(value, ['applicationId', 'workspaceId', 'groupId']);
    if (
        typeof value.applicationId !== 'string' || value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' ||
        typeof value.groupId !== 'string' || value.groupId.length === 0
    ) {
        throw new TypeError('Legacy RTC topology publication groupRef is invalid');
    }
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId
    };
}
