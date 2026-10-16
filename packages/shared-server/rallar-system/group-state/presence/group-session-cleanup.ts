import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

export interface GroupSessionCleanupInput {
    readonly scope: StateScope;
    readonly authSession: Omit<IssuedAuthSession, 'accessToken'>;
    readonly principalId: string;
    readonly disconnectedAtEpochMs: number;
}

/**
 * The connection facts were verified when the socket was authorised, and cleanup only closes that
 * connection's presence, so it needs no live auth session: a logout or an expired auth session
 * before the close still closes the rows.
 */
export async function readGroupSessionCleanupCandidates(
    repository: GroupStateRepository,
    input: GroupSessionCleanupInput
): Promise<readonly GroupPresenceSession[]> {
    return (await repository.listPresenceSessionsForSessionIds([input.authSession.sessionId])).filter(
        (session) =>
            session.applicationId === input.scope.applicationId &&
            session.workspaceId === input.scope.workspaceId &&
            session.principalId === input.principalId &&
            session.principalId === input.authSession.clientId &&
            session.disconnectedAtEpochMs === null &&
            session.connectedAtEpochMs <= input.disconnectedAtEpochMs &&
            session.lastHeartbeatAtEpochMs <= input.disconnectedAtEpochMs
    );
}
