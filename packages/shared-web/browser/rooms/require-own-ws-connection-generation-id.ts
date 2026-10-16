import type { AuthSession } from '@shared/api/api-config.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';

/**
 * The server stamps the authorised socket's generation on the session's client snapshot before the socket upgrades,
 * so a connected browser has it cached; a presence row names it, and that socket's close cleans only its own rows.
 */
export function requireOwnWsConnectionGenerationId(session: AuthSession): string {
    const ownSession = clientStateSnapshotsRepository
        .findClientStateSnapshotByPrincipalId(session.clientId)
        ?.activeSessions.find((candidate) => candidate.sessionId === session.sessionId);
    if (ownSession === undefined) {
        throw new Error('Cannot connect room presence: the WebSocket connection generation is not known yet.');
    }
    return ownSession.generationId;
}
