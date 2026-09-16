import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedGroupRef
} from '../distributed-run.ts';

export function isControlAgentIdentityInGroup(
    identity: RallarBlackBoxControlAgentIdentity | undefined,
    group: RallarBlackBoxDistributedGroupRef
): identity is RallarBlackBoxControlAgentIdentity {
    if (!identity) {
        return false;
    }

    return identity.applicationId === group.applicationId &&
        identity.workspaceId === group.workspaceId &&
        identity.groupId === group.groupId;
}

export function isControlAgentStale(
    agent: RallarBlackBoxControlAgentCandidate,
    nowEpochMs: number,
    staleAfterMs: number
): boolean {
    const lastSeen = agent.lastHeartbeatAtEpochMs ?? agent.lastSeenAtEpochMs ?? agent.identity?.updatedAtEpochMs;
    return typeof lastSeen === 'number' && nowEpochMs - lastSeen > staleAfterMs;
}
