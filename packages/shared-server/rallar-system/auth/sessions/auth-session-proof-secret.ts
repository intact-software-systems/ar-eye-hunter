import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type {
  IssuedAuthSession,
  PersistedAuthSession,
} from '../../repositories/AuthSessionRepository.ts';

export async function authSessionProofSecret(
  session: IssuedAuthSession | PersistedAuthSession,
): Promise<string> {
  return 'accessTokenDigest' in session
    ? session.accessTokenDigest
    : await hashAuthSecret(session.accessToken);
}
