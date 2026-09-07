import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';

export function isRtcTopologyCurrentStateMessage(
    snapshot: CompletedStateSnapshot,
    topology: RallarOverlayTopologySnapshot,
    sessionId: string
): boolean {
    const message = snapshot.envelope;
    if (
        message.audit?.createdBy !== message.id.senderId
    ) {
        return false;
    }
    const identity = readTopologyMessageIdentity(snapshot.page.originalMessageId);
    if (!identity) {
        return false;
    }
    const revision = topology.sourceGroupStateCausalRevision;
    if (identity[0] === 'rtc-topology-current-repair') {
        const targets = message.targets;
        return identity.length === 5 &&
            identity[1] === toCanonicalGroupIdentity(topology) &&
            identity[2] === revision.groupRevision &&
            identity[3] === revision.presenceRevision &&
            identity[4] === topology.version &&
            targets?.mode === 'broadcast' &&
            targets.scope === 'room' &&
            targets.groupRef?.applicationId === topology.groupRef.applicationId &&
            targets.groupRef.workspaceId === topology.groupRef.workspaceId &&
            targets.groupRef.groupId === topology.groupRef.groupId;
    }
    if (identity[0] === 'rtc-topology-hydration') {
        const targets = message.targets;
        return identity.length === 9 &&
            identity[1] === topology.groupRef.applicationId &&
            identity[2] === topology.groupRef.workspaceId &&
            identity[3] === topology.groupRef.groupId &&
            identity[4] === sessionId &&
            typeof identity[5] === 'string' && identity[5].length > 0 &&
            identity[6] === revision.groupRevision &&
            identity[7] === revision.presenceRevision &&
            identity[8] === topology.version &&
            message.id.sessionId === sessionId &&
            targets?.mode === 'unicast' &&
            targets.toPeerId === sessionId;
    }
    return false;
}

function readTopologyMessageIdentity(
    messageId: string
): readonly (string | number)[] | undefined {
    try {
        const identity = JSON.parse(messageId) as readonly (string | number)[];
        if (
            !Array.isArray(identity) ||
            identity.some((part) => typeof part !== 'string' && typeof part !== 'number')
        ) {
            return undefined;
        }
        return identity;
    }
    catch {
        return undefined;
    }
}

function toCanonicalGroupIdentity(topology: RallarOverlayTopologySnapshot): string {
    return JSON.stringify([
        topology.groupRef.applicationId,
        topology.groupRef.workspaceId === undefined
            ? ['absent']
            : ['present', topology.groupRef.workspaceId],
        topology.groupRef.groupId
    ]);
}
