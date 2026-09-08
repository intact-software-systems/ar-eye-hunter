import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeStateSnapshotPages } from '@shared/api/state-snapshot-page.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { toRtcTopologyPublicationMessageId } from '../persistence/rtc-topology-identifiers.ts';

export interface RtcOverlayTopologyMessageFacts {
    readonly workId: string;
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export interface RtcOverlayTopologyPublicationInput extends RtcOverlayTopologyMessageFacts {
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly targetGroupSnapshotVersion: number;
}

export function materializeRtcOverlayTopologyMessages(input: RtcOverlayTopologyPublicationInput): readonly ALMessage[] {
    const { snapshot, createdAtEpochMs, expiresAtEpochMs } = input;
    const revision = snapshot.sourceGroupStateCausalRevision;
    return computeStateSnapshotPages({
        scope: {
            applicationId: snapshot.groupRef.applicationId,
            workspaceId: snapshot.groupRef.workspaceId,
            kind: 'group',
            resourceId: snapshot.groupRef.groupId
        },
        revision: JSON.stringify([revision.groupRevision, revision.presenceRevision, snapshot.version]),
        resource: JSON.stringify(snapshot),
        envelope: {
            id: {
                v: 2,
                msgId: toRtcTopologyPublicationMessageId(input.workId),
                ts: createdAtEpochMs,
                senderId: 'rallar-server'
            },
            route: toAppQueueKey({
                topicId: AppTopics.overlayTopology,
                contextId: snapshot.groupRef.groupId,
                resourceId:
                    `${snapshot.overlayId}:${revision.groupRevision}:${revision.presenceRevision}:${snapshot.version}`
            }),
            constraints: { expiresAtMs: expiresAtEpochMs },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: snapshot.groupRef,
                minSnapshotVersion: input.targetGroupSnapshotVersion,
                recipientPeerIds: snapshot.activeSessionIds
            },
            delivery: { reliability: 'best-effort', ack: 'none' },
            audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
        }
    }).fold((issue) => {
        throw new TypeError(issue.message);
    }, (pages) => pages);
}
