import type { RallarBlackBoxControlAgentIdentity } from '@shared-test/rallar-bb-test/distributed-run.ts';

/**
 * One operator-readable line for an agent's registered identity. Absent when the agent registered
 * without an identity block, or when the block carries no principal, group, session or scope.
 */
export function toControlAgentIdentitySummary(
    identity: RallarBlackBoxControlAgentIdentity | undefined
): string | undefined {
    if (!identity) {
        return undefined;
    }

    const principal = identity.principalId ?? identity.clientId ?? identity.username;
    const group = identity.groupId;
    const session = identity.sessionId;
    const scope = [identity.applicationId, identity.workspaceId]
        .filter(Boolean)
        .join('/');

    return [
        principal,
        group ? `group ${group}` : undefined,
        session ? `session ${session}` : undefined,
        scope ? `scope ${scope}` : undefined
    ].filter(Boolean).join(' - ') || undefined;
}
