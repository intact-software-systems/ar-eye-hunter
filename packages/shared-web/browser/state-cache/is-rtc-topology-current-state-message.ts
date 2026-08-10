import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export function isRtcTopologyCurrentStateMessage(
    message: ALMessage,
    topology: RallarOverlayTopologySnapshot,
    sessionId: string,
): boolean {
    if (
        message.id.senderId !== 'rallar-server' ||
        message.audit?.createdBy !== 'rallar-server'
    ) {
        return false;
    }
    const identity = readTopologyMessageIdentity(message.id.msgId);
    if (!identity) return false;
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
        return identity.length === 6 &&
            identity[1] === sessionId &&
            typeof identity[2] === 'string' &&
            identity[2].length > 0 &&
            identity[3] === revision.groupRevision &&
            identity[4] === revision.presenceRevision &&
            identity[5] === topology.version &&
            message.id.sessionId === sessionId &&
            targets?.mode === 'unicast' &&
            targets.toPeerId === sessionId;
    }
    return false;
}

function readTopologyMessageIdentity(
    messageId: string,
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
    } catch {
        return undefined;
    }
}

function toCanonicalGroupIdentity(topology: RallarOverlayTopologySnapshot): string {
    return JSON.stringify([
        topology.groupRef.applicationId,
        topology.groupRef.workspaceId === undefined
            ? ['absent']
            : ['present', topology.groupRef.workspaceId],
        topology.groupRef.groupId,
    ]);
}
