import { hashAuthSecret } from '../auth/credentials/hash-auth-secret.ts';
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
