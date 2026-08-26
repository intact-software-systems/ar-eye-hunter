import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';

export async function persistAuthSession(session: IssuedAuthSession): Promise<PersistedAuthSession> {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}
