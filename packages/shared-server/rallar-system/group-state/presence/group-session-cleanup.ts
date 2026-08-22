import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { AuthSessionRepository } from '../../repositories/AuthSessionRepository.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';

export interface GroupSessionCleanupInput {
    readonly scope: StateScope;
    readonly authSession: Omit<IssuedAuthSession, 'accessToken'>;
    readonly principalId: string;
    readonly disconnectedAtEpochMs: number;
}

export async function readGroupSessionCleanupCandidates(
    repository: GroupStateRepository,
    authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>,
    input: GroupSessionCleanupInput
): Promise<readonly GroupPresenceSession[]> {
    const authority = await authSessionRepository.findBySessionId(input.authSession.sessionId);
    if (
        !authority ||
        authority.clientId !== input.principalId ||
        authority.clientId !== input.authSession.clientId ||
        authority.username !== input.authSession.username ||
        authority.issuedAtEpochMs !== input.authSession.issuedAtEpochMs ||
        authority.expiresAtEpochMs !== input.authSession.expiresAtEpochMs
    ) {
        throw new TypeError('Group session cleanup authority is no longer valid');
    }

    return (await repository.listAllPresenceSessions()).filter(
        (session) =>
            session.applicationId === input.scope.applicationId &&
            session.workspaceId === input.scope.workspaceId &&
            session.sessionId === input.authSession.sessionId &&
            session.principalId === input.principalId &&
            session.disconnectedAtEpochMs === null &&
            session.connectedAtEpochMs <= input.disconnectedAtEpochMs &&
            session.lastHeartbeatAtEpochMs <= input.disconnectedAtEpochMs
    );
}
