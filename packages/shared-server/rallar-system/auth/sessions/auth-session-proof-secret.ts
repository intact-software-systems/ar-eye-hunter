import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type { PersistedAuthSession } from '../persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '../persistence/auth-session-types.ts';

export async function authSessionProofSecret(
  session: IssuedAuthSession | PersistedAuthSession,
): Promise<string> {
  return 'accessTokenDigest' in session
    ? session.accessTokenDigest
    : await hashAuthSecret(session.accessToken);
}
