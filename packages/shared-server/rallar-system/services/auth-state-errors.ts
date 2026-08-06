import { hashAuthSecret } from '../repositories/AuthSessionRepository.ts';
import { AuthMutationRejectedError } from '../auth/mutation/auth-mutation-rejected-error.ts';

export async function requireMatchingCredentialDigest(
    credential: string,
    expectedDigest: string,
    message: string,
): Promise<void> {
    if (await hashAuthSecret(credential) !== expectedDigest) {
        throw new AuthMutationRejectedError(message);
    }
}
