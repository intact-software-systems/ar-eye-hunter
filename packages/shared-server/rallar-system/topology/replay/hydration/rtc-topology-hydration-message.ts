import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ConnectionContext } from '@shared/websocket/JsonWebSocketServer.ts';

import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../consumer/rtc-topology-replay-policy.ts';

export interface RtcTopologyHydrationMessageInput {
    readonly connection: ConnectionContext;
    readonly topology: RallarOverlayTopologySnapshot;
    readonly nowEpochMs: number;
}

export function materializeRtcTopologyHydrationMessage(
    input: RtcTopologyHydrationMessageInput
): ALMessage {
    const { connection, topology, nowEpochMs } = input;
    const revision = topology.sourceGroupStateCausalRevision;
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: JSON.stringify([
                'rtc-topology-hydration',
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
        route: {
            topicId: AppTopics.overlayTopology,
            contextId: topology.groupRef.groupId,
            resourceId: `${topology.overlayId}:${revision.groupRevision}:` +
                `${revision.presenceRevision}:${topology.version}`
        },
        constraints: {
            expiresAtMs: nowEpochMs + RTC_TOPOLOGY_REPLAY_RETENTION_MS
        },
        targets: { mode: 'unicast', toPeerId: connection.id },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json',
            resource: JSON.stringify(topology)
        },
        audit: { createdBy: 'rallar-server', createdTs: nowEpochMs }
    };
    validatePersistedALMessage(message);
    return message;
}
