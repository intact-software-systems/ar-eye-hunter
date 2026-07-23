import { hashAuthSecret } from '../repositories/AuthSessionRepository.ts';

export class AuthMutationRejectedError extends Error {
    readonly code = 'auth-mutation-rejected';

    constructor(message: string, readonly status = 409) {
        super(message);
        this.name = 'AuthMutationRejectedError';
    }
}

export async function requireMatchingCredentialDigest(
    credential: string,
    expectedDigest: string,
    message: string,
): Promise<void> {
    if (await hashAuthSecret(credential) !== expectedDigest) {
        throw new AuthMutationRejectedError(message);
    }
}
