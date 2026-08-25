import { toRtcTopologyPublicationId, toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export interface RtcTopologyReplayFixture {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly publication: RtcTopologyPublication;
    readonly outbox: ResourceEntry;
    readonly currentSnapshot: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export function createRtcTopologyReplayFixture(): RtcTopologyReplayFixture {
    const publication = topologyPublication();
    const outbox = computeRtcTopologyPublicationOutbox(publication);
    return {
        entry: {
            publisherStreamId: '00000000-0000-4000-8000-000000000002',
            sequence: 1,
            groupRef: publication.groupRef,
            publicationId: publication.publicationId,
            outboxKey: outbox.key,
            retainUntilEpochMs: publication.message.constraints!.expiresAtMs!,
            insertedAtEpochMs: publication.createdAtEpochMs
        },
        publication,
        outbox,
        currentSnapshot: JSON.parse(
            publication.message.payload.resource
        ) as RallarOverlayTopologySnapshot,
        databaseNowEpochMs: publication.createdAtEpochMs
    };
}

function topologyPublication(): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'replay-app',
        workspaceId: 'replay-workspace',
        groupId: 'replay-group'
    };
    const causalRevision = { groupRevision: 4, presenceRevision: 6 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 86_401_000;
    const workId = 'replay-work';
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Replay group',
        topology: 'tree',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 2,
        version: 8,
        createdByClientId: 'principal-1',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs
    };
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: causalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: causalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 10,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: {
                v: 2,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs,
                senderId: 'rallar-server'
            },
            route: {
                topicId: AppTopics.overlayTopology,
                resourceId: `${snapshot.overlayId}:4:6:8`,
                contextId: groupRef.groupId
            },
            constraints: { expiresAtMs },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef,
                minSnapshotVersion: 10
            },
            delivery: { reliability: 'best-effort', ack: 'none' },
            payload: {
                typeId: AppTopics.overlayTopology,
                contentType: 'application/json',
                resource: JSON.stringify(snapshot)
            },
            audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
        },
        createdAtEpochMs
    };
}
