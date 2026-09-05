import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeStateSnapshotPages, type StateSnapshotEnvelope } from '@shared/api/state-snapshot-page.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../consumer/rtc-topology-replay-policy.ts';

export interface RtcTopologyHydrationMessageInput {
    readonly connection: ConnectionContext;
    readonly topology: RallarOverlayTopologySnapshot;
    readonly nowEpochMs: number;
}

export function materializeRtcTopologyHydrationMessages(
    input: RtcTopologyHydrationMessageInput
): readonly ALMessage[] {
    const { connection, topology, nowEpochMs } = input;
    const revision = topology.sourceGroupStateCausalRevision;
    const envelope: StateSnapshotEnvelope = {
        id: {
            v: 2,
            msgId: JSON.stringify([
                'rtc-topology-hydration',
                topology.groupRef.applicationId,
                topology.groupRef.workspaceId,
                topology.groupRef.groupId,
                connection.id,
                connection.generationId,
                revision.groupRevision,
                revision.presenceRevision,
                topology.version
            ]),
            ts: connection.generationStartedAtEpochMs,
            senderId: 'rallar-server',
            sessionId: connection.id
        },
        route: toAppQueueKey({
            topicId: AppTopics.overlayTopology,
            contextId: topology.groupRef.groupId,
            resourceId: `${topology.overlayId}:${revision.groupRevision}:` +
                `${revision.presenceRevision}:${topology.version}`
        }),
        constraints: {
            expiresAtMs: nowEpochMs + RTC_TOPOLOGY_REPLAY_RETENTION_MS
        },
        targets: { mode: 'unicast', toPeerId: connection.id },
        delivery: { reliability: 'best-effort', ack: 'none' },
        audit: { createdBy: 'rallar-server', createdTs: nowEpochMs }
    };
    return computeStateSnapshotPages({
        envelope,
        scope: {
            applicationId: topology.groupRef.applicationId,
            workspaceId: topology.groupRef.workspaceId,
            kind: 'group',
            resourceId: topology.groupRef.groupId
        },
        revision: JSON.stringify([revision.groupRevision, revision.presenceRevision, topology.version]),
        resource: JSON.stringify(topology)
    }).fold((issue) => {
        throw new TypeError(issue.message);
    }, (pages) => pages);
}
