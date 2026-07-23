import {
    hashAuthSecret,
    type IssuedAuthSession,
    type PersistedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

export type AuthSession = IssuedAuthSession;
export type StoredAuthSession = PersistedAuthSession;

export async function persistAuthSession(
    session: AuthSession,
): Promise<StoredAuthSession> {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}
