import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';

export type AuthSession = IssuedAuthSession;
export type StoredAuthSession = PersistedAuthSession;

export async function persistAuthSession(session: AuthSession): Promise<StoredAuthSession> {
  return {
    clientId: session.clientId,
    username: session.username,
    sessionId: session.sessionId,
    accessTokenDigest: await hashAuthSecret(session.accessToken),
    issuedAtEpochMs: session.issuedAtEpochMs,
    expiresAtEpochMs: session.expiresAtEpochMs,
  };
}
