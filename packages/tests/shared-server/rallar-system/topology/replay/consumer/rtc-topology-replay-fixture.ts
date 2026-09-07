import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export interface RtcTopologyReplayFixture {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly publication: RtcTopologyPublication;
    readonly outbox: readonly ResourceEntry[];
    readonly currentSnapshot: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export function createRtcTopologyReplayFixture(sessionCount = 1): RtcTopologyReplayFixture {
    const publication = topologyPublication(sessionCount);
    const outbox = computeRtcTopologyPublicationOutbox(publication);
    return {
        entry: {
            publisherStreamId: '00000000-0000-4000-8000-000000000002',
            sequence: 1,
            groupRef: publication.groupRef,
            publicationId: publication.publicationId,
            outboxKey: outbox[0].key,
            retainUntilEpochMs: publication.expiresAtEpochMs,
            insertedAtEpochMs: publication.createdAtEpochMs
        },
        publication,
        outbox,
        currentSnapshot: publication.snapshot,
        databaseNowEpochMs: publication.createdAtEpochMs
    };
}

function topologyPublication(sessionCount: number): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'replay-app',
        workspaceId: 'replay-workspace',
        groupId: 'replay-group'
    };
    const causalRevision = { groupRevision: 4, presenceRevision: 6 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 86_401_000;
    const workId = 'replay-work';
    const activeSessionIds = Array.from({ length: sessionCount }, (_, index) => `session-${index + 1}`).sort();
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Replay group',
        topology: 'tree',
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            activeSessionIds.map((
                id,
                index
            ) => [id, activeSessionIds.slice(Math.max(0, index - 1), index).concat(activeSessionIds.slice(index + 1, index + 2))])
        ),
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
        snapshot,
        expiresAtEpochMs: expiresAtMs,
        createdAtEpochMs
    };
}
